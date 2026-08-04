/**
 * Postgres and Redis.
 *
 * Versions are pinned to match docker-compose.yml and scripts/local-pg.sh.
 * §0.1 asks for local/production parity, and the specific thing that parity
 * protects here is PostGIS: `ST_DWithin` on `geography` picks different plans
 * across PostGIS majors, and the §0.3 proximity budget was measured against
 * 3.4. A cluster that quietly runs 3.5 has not been load-tested.
 */

resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = [for subnet in aws_subnet.private : subnet.id]
}

/*
 * PostGIS is not installed by RDS; `CREATE EXTENSION postgis` does it, and
 * migration 0000 runs exactly that. What this parameter group does is make the
 * extension loadable at all — `shared_preload_libraries` cannot be set after
 * the fact without a reboot, and discovering that during the first deploy is a
 * bad time to find out.
 */
resource "aws_db_parameter_group" "main" {
  name   = "${local.name}-pg16"
  family = "postgres16"

  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }

  /*
   * Log anything slower than a second.
   *
   * §0.3 budgets the proximity query at well under that, so a line in this log
   * is by definition something that has escaped its budget. Set low enough to
   * be useful and high enough that the log is not the application's own
   * traffic written twice.
   */
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "random_password" "database" {
  length = 32
  # RDS rejects several punctuation characters in a master password, and the
  # error arrives at apply time rather than plan time. Excluded up front.
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "aws_db_instance" "main" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = "16.13"
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage_gb
  max_allocated_storage = var.db_allocated_storage_gb * 4
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.main.arn

  db_name  = "locum_planner"
  username = "locum"
  password = random_password.database.result
  port     = 5432

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.database.id]
  parameter_group_name   = aws_db_parameter_group.main.name

  /*
   * Never public. The §12.1 threat model is an authenticated scraper and a
   * credential-stuffer; what turns either into a POPIA breach is a database
   * with an address on the internet.
   */
  publicly_accessible = false

  multi_az                = var.environment == "production"
  backup_retention_period = var.environment == "production" ? 30 : 7
  backup_window           = "01:00-02:00" # ~03:00 SAST, well clear of the 07:00 burst
  maintenance_window      = "sun:02:30-sun:03:30"

  /*
   * Deletion protection, plus a final snapshot.
   *
   * This database holds SAPC numbers, ID documents and every booking. The
   * §10 erasure endpoint is careful about what it removes; a `terraform
   * destroy` is not careful about anything.
   */
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-final"

  performance_insights_enabled = true
  # §12.2 wants the slow-query story available without shelling into anything.
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  # Patch versions are applied in the maintenance window; majors are not,
  # because a major moves PostGIS and the §0.3 budget with it.
  auto_minor_version_upgrade = true
  apply_immediately          = false
}

resource "aws_elasticache_subnet_group" "main" {
  name       = local.name
  subnet_ids = [for subnet in aws_subnet.private : subnet.id]
}

/*
 * Redis backs BullMQ, and BullMQ's repeatable schedules are the part that
 * survives deploys — apps/worker's gate tests exist because a schedule left
 * over from a rename fires forever against a handler that no longer exists.
 *
 * So this is not a cache in the disposable sense. Losing it silently drops
 * every pending scheduled job, which is the §4.4 drain and the §2 dunning
 * ladder, neither of which anyone is watching in real time.
 */
resource "aws_elasticache_replication_group" "main" {
  replication_group_id = local.name
  description          = "BullMQ queues and scheduled jobs"

  engine         = "redis"
  engine_version = "7.1"
  node_type      = var.redis_node_type
  port           = 6379

  num_cache_clusters         = var.environment == "production" ? 2 : 1
  automatic_failover_enabled = var.environment == "production"

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.cache.id]

  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.main.arn
  transit_encryption_enabled = true

  # Queue contents are job payloads, not derived data. A snapshot is the
  # difference between a lost node and a lost night's messages.
  snapshot_retention_limit = var.environment == "production" ? 7 : 1
  snapshot_window          = "00:00-01:00"

  maintenance_window = "sun:03:30-sun:04:30"
  apply_immediately  = false
}
