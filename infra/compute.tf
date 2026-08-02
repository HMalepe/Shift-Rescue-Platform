/**
 * ECS Fargate: the API behind a load balancer, the worker behind nothing.
 *
 * The worker deliberately has no load balancer, no target group and no health
 * check reachable from outside. Nothing calls it; it wakes on a schedule. That
 * is also why §0.1 alerting matters more for the worker than for the API — a
 * failed API request has a person waiting on it, and a failed drain has
 * nobody.
 */

resource "aws_ecr_repository" "api" {
  name                 = "${local.name}/api"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.main.arn
  }
}

/*
 * Immutable tags, which is a deployment decision as much as a security one.
 *
 * A mutable `latest` means the image a task pulls depends on when it started,
 * so a task replaced at 03:00 by a spot reclamation can be running different
 * code from its siblings — and the §12.5 ledger records gates against a commit.
 * A gate that passed against a tag is evidence about nothing in particular.
 */
resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 30 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 30
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.name}/api"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.main.arn
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${local.name}/worker"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.main.arn
}

# ---------------------------------------------------------------------------
# IAM
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

/*
 * Two roles, not one.
 *
 * The execution role is what ECS itself uses to pull the image and read the
 * secrets it injects. The task role is what the application code holds at
 * runtime. Collapsing them would give application code — the part exposed to
 * the internet — the ability to read every secret in the namespace, including
 * ones it never uses.
 */
resource "aws_iam_role" "execution" {
  name               = "${local.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = concat(
      [
        aws_secretsmanager_secret.auth.arn,
        aws_secretsmanager_secret.database_url.arn,
      ],
      [for secret in aws_secretsmanager_secret.vendor : secret.arn],
    )
  }

  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.main.arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

/*
 * What the application may do to the documents bucket: put, get, delete.
 *
 * No `s3:PutBucketPolicy`, no `s3:PutBucketPublicAccessBlock`, no
 * `s3:DeleteBucket`. The invariants in storage.tf are enforced by the bucket
 * configuration, and application code should not hold the ability to edit the
 * configuration that constrains it — a compromise of the API then cannot make
 * the bucket public as a first step.
 */
data "aws_iam_policy_document" "task" {
  statement {
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.documents.arn}/*"]
  }

  statement {
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.main.arn]
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "runtime"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

# ---------------------------------------------------------------------------
# Load balancer
# ---------------------------------------------------------------------------

resource "aws_lb" "main" {
  name               = local.name
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [for subnet in aws_subnet.public : subnet.id]

  # Longer than the longest thing the API does, and long enough that a slow
  # booking confirmation under contention is not cut off mid-transaction.
  idle_timeout               = 60
  drop_invalid_header_fields = true
  enable_deletion_protection = var.environment == "production"
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name}-api"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    path                = "/health"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }

  /*
   * Drain for 30 seconds on deregistration.
   *
   * main.ts handles SIGTERM by draining in-flight requests, and the comment
   * there names the case: a booking confirmation killed mid-transaction leaves
   * a manager with no answer about whether their pharmacy has cover tomorrow.
   * This is the load balancer's half of that agreement.
   */
  deregistration_delay = 30
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  # TLS 1.2 minimum, which is also what a POPIA operator agreement will expect.
  ssl_policy      = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------

locals {
  # Injected by ECS from Secrets Manager rather than baked into the task
  # definition, where they would be visible to anyone with DescribeTaskDefinition.
  common_secrets = [
    { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
    { name = "AUTH_SECRET", valueFrom = aws_secretsmanager_secret.auth.arn },
    { name = "TWILIO_AUTH_TOKEN", valueFrom = aws_secretsmanager_secret.vendor["twilio-auth-token"].arn },
    { name = "ALERT_WEBHOOK_URL", valueFrom = aws_secretsmanager_secret.vendor["alert-webhook-url"].arn },
  ]

  common_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "ENVIRONMENT", value = var.environment },
    { name = "REDIS_URL", value = "rediss://${aws_elasticache_replication_group.main.primary_endpoint_address}:6379" },
    { name = "S3_BUCKET", value = aws_s3_bucket.documents.id },
    { name = "S3_REGION", value = var.region },
    { name = "S3_KMS_KEY_ID", value = aws_kms_key.main.arn },
    { name = "PUBLIC_BASE_URL", value = var.public_base_url },
  ]
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([{
    name      = "api"
    image     = "${aws_ecr_repository.api.repository_url}:${var.image_tag}"
    essential = true

    portMappings = [{ containerPort = 3000, protocol = "tcp" }]
    environment  = local.common_environment
    secrets      = local.common_secrets

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.api.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "api"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([{
    name      = "worker"
    essential = true
    image     = "${aws_ecr_repository.api.repository_url}:${var.image_tag}"
    # Same image, different entrypoint. One build, so the worker cannot be
    # running a different commit from the API that enqueued the work.
    command = ["pnpm", "--filter", "@locum/worker", "start"]

    environment = local.common_environment
    secrets = concat(local.common_secrets, [
      { name = "PAYFAST_PASSPHRASE", valueFrom = aws_secretsmanager_secret.vendor["payfast-passphrase"].arn },
      { name = "PAYFAST_MERCHANT_KEY", valueFrom = aws_secretsmanager_secret.vendor["payfast-merchant-key"].arn },
    ])

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.worker.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "worker"
      }
    }
  }])
}

resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.environment == "production" ? 2 : 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = [for subnet in aws_subnet.private : subnet.id]
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }

  # Long enough for migrations and a cold start; short enough that a task
  # failing to boot is noticed rather than retried quietly for ten minutes.
  health_check_grace_period_seconds = 60

  depends_on = [aws_lb_listener.https]
}

/*
 * Exactly one worker. Not autoscaled, deliberately.
 *
 * The §4.4 drain claims with `FOR UPDATE SKIP LOCKED`, so more workers is safe
 * for correctness — but the batch size is what paces the 07:00 backlog against
 * Twilio's rate limits, and a second worker doubles the send rate without
 * changing that number. §11.6's spend cap is per day, not per worker.
 *
 * Scale this by raising DRAIN_BATCH_SIZE after watching what Twilio tolerates,
 * not by adding tasks.
 */
resource "aws_ecs_service" "worker" {
  name            = "worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = [for subnet in aws_subnet.private : subnet.id]
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }
}
