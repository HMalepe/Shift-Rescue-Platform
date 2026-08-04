/**
 * §0.1 — infrastructure alarms.
 *
 * These are NOT the application's alerting. `packages/observability` posts to a
 * webhook and pages a human, and the §0.1 drill exists to prove that path works
 * end to end. What CloudWatch covers is the class of failure the application
 * cannot report on, because by then it is not running: the database out of
 * connections, the cluster out of tasks, the account out of money.
 *
 * The distinction matters. A service that alerts on its own health is a service
 * that goes quiet exactly when things are worst.
 */

resource "aws_sns_topic" "alerts" {
  name              = "${local.name}-alerts"
  kms_master_key_id = aws_kms_key.main.id
}

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

/*
 * The API having zero healthy targets.
 *
 * This is the outage that looks like nothing from inside the application: the
 * tasks are gone, so there is no code left to report anything. Treating
 * missing data as breaching is the point — "no data" here means the load
 * balancer has nothing to talk to.
 */
resource "aws_cloudwatch_metric_alarm" "api_unhealthy" {
  alarm_name          = "${local.name}-api-no-healthy-targets"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1
  treat_missing_data  = "breaching"

  dimensions = {
    TargetGroup  = aws_lb_target_group.api.arn_suffix
    LoadBalancer = aws_lb.main.arn_suffix
  }

  alarm_description = "No healthy API tasks. The application cannot report this itself."
  alarm_actions     = [aws_sns_topic.alerts.arn]
  ok_actions        = [aws_sns_topic.alerts.arn]
}

/*
 * The worker stopping.
 *
 * Nobody is waiting on the worker, which is the whole reason it needs
 * watching. If it stops, the §4.4 drain stops and the 07:00 backlog simply
 * never goes out — no error, no failed request, no user complaint until
 * pharmacists start asking why nobody replied.
 */
resource "aws_cloudwatch_metric_alarm" "worker_stopped" {
  alarm_name          = "${local.name}-worker-not-running"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  metric_name         = "RunningTaskCount"
  namespace           = "ECS/ContainerInsights"
  period              = 60
  statistic           = "Average"
  threshold           = 1
  treat_missing_data  = "breaching"

  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.worker.name
  }

  alarm_description = "The scheduled-jobs worker is not running. Nothing else will notice."
  alarm_actions     = [aws_sns_topic.alerts.arn]
  ok_actions        = [aws_sns_topic.alerts.arn]
}

/*
 * Database connections approaching the pool ceiling.
 *
 * DATABASE_MAX_CONNECTIONS defaults to 10 per task. This fires while there is
 * still headroom, because the symptom of running out is booking confirmations
 * timing out under exactly the contention §0.3 measures — and by then the
 * §12.3 latency budget has already been missed.
 */
resource "aws_cloudwatch_metric_alarm" "database_connections" {
  alarm_name          = "${local.name}-database-connections-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "DatabaseConnections"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Average"
  threshold           = 60
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.id
  }

  alarm_description = "Connections climbing toward the pool ceiling."
  alarm_actions     = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "database_storage" {
  alarm_name          = "${local.name}-database-storage-low"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "FreeStorageSpace"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 5 * 1024 * 1024 * 1024 # 5 GiB
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.id
  }

  alarm_description = "Under 5 GiB free. Autoscaling should have handled this; if it fires, it did not."
  alarm_actions     = [aws_sns_topic.alerts.arn]
}

/*
 * A budget, because §11.6's WhatsApp spend cap only covers WhatsApp.
 *
 * The failure this catches is not a runaway send — the application caps that
 * itself. It is the ordinary kind: a NAT gateway moving more data than
 * expected, a forgotten staging environment, RDS storage autoscaling upward
 * every night. None of those raise an application error, and all of them are
 * noticed by the invoice unless something says so first.
 */
resource "aws_budgets_budget" "monthly" {
  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = var.monthly_budget_usd
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  /*
   * `format`, not interpolation, and that is not a style preference.
   *
   * The Budgets tag filter is literally `user:<Key>$<Value>` — a `$`
   * immediately before the value. Written inline as "...$${var.environment}"
   * HCL reads the `$${` as an escape and emits a literal `${var.environment}`;
   * adding another `$` produces `$${var.environment}`. Both are accepted by
   * Terraform, and both give a budget that filters on a tag value no resource
   * has, so it reports zero spend forever and never alerts.
   *
   * Verified by evaluating all three forms rather than reasoning about them.
   */
  cost_filter {
    name   = "TagKeyValue"
    values = [format("user:Environment$%s", var.environment)]
  }

  # 80% of actual, and a forecast that would exceed 100%. The forecast is the
  # useful one: it fires while there is still a month left to do something.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}
