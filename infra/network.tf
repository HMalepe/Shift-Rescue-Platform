/**
 * VPC: public subnets for the load balancer, private subnets for everything
 * that holds data.
 *
 * The database and cache have no route to the internet and no public address.
 * That is not defence in depth for its own sake — §12.1's threat model is an
 * authenticated scraper and a credential-stuffer, and the thing that turns
 * either into a POPIA breach is a data store reachable from outside.
 */

locals {
  name = "locum-${var.environment}"
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = local.name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = local.name }
}

resource "aws_subnet" "public" {
  for_each = { for index, az in var.availability_zones : az => index }

  vpc_id                  = aws_vpc.main.id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, each.value)
  map_public_ip_on_launch = false

  tags = { Name = "${local.name}-public-${each.key}" }
}

resource "aws_subnet" "private" {
  for_each = { for index, az in var.availability_zones : az => index }

  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, each.value + 100)

  tags = { Name = "${local.name}-private-${each.key}" }
}

/*
 * One NAT gateway, in the first AZ.
 *
 * A NAT per AZ removes a failure mode: lose that AZ and the other AZ's tasks
 * lose outbound internet, which means no Twilio and no Payfast until it comes
 * back. It also roughly doubles a line item that is already one of the larger
 * ones in af-south-1.
 *
 * Single NAT is the deliberate choice for launch. The failure it accepts is
 * "outbound calls stop during an AZ outage", and the mitigation is that the
 * §4.4 drain and §2 dunning are both queues that retry — a booking
 * confirmation is delayed, not lost. Revisit when that stops being true.
 */
resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${local.name}-nat" }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[var.availability_zones[0]].id
  depends_on    = [aws_internet_gateway.main]

  tags = { Name = local.name }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }

  tags = { Name = "${local.name}-private" }
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  for_each = aws_subnet.private

  subnet_id      = each.value.id
  route_table_id = aws_route_table.private.id
}

/*
 * A gateway endpoint for S3.
 *
 * Document uploads are the largest thing this application moves, and without
 * this every byte goes out through the NAT gateway and is billed per gigabyte
 * on the way. The endpoint is free. It also keeps the traffic off the public
 * internet, which for identity documents is worth having on its own.
 */
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]

  tags = { Name = "${local.name}-s3" }
}

# ---------------------------------------------------------------------------
# Security groups
# ---------------------------------------------------------------------------

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public load balancer"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.name}-alb" }
}

/*
 * 443 only. There is no port 80 listener and no redirect.
 *
 * A redirect is friendlier and it also means the first request of every
 * session travels in clear text — including, for a mobile client that does not
 * follow redirects the way a browser does, an Authorization header. §12.1 puts
 * the session cookie in httpOnly/Secure form for the same reason.
 */
resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from the internet"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To the API tasks"
  referenced_security_group_id = aws_security_group.tasks.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "tasks" {
  name        = "${local.name}-tasks"
  description = "API and worker tasks"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.name}-tasks" }
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  security_group_id            = aws_security_group.tasks.id
  description                  = "From the load balancer only"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}

/*
 * Unrestricted egress, which is a real decision rather than an oversight.
 *
 * These tasks call Twilio, Payfast and the §0.1 alert sink, none of which
 * publishes a stable address range. Pinning egress to a list that vendors
 * change without notice produces an outage whose cause is invisible from the
 * application's logs — the request simply never completes.
 */
resource "aws_vpc_security_group_egress_rule" "tasks_out" {
  security_group_id = aws_security_group.tasks.id
  description       = "Vendor APIs, S3, RDS, Redis"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "database" {
  name        = "${local.name}-database"
  description = "Postgres. Reachable only from the tasks."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.name}-database" }
}

resource "aws_vpc_security_group_ingress_rule" "database_from_tasks" {
  security_group_id            = aws_security_group.database.id
  description                  = "Postgres from the tasks"
  referenced_security_group_id = aws_security_group.tasks.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "cache" {
  name        = "${local.name}-cache"
  description = "Redis. Reachable only from the tasks."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.name}-cache" }
}

resource "aws_vpc_security_group_ingress_rule" "cache_from_tasks" {
  security_group_id            = aws_security_group.cache.id
  description                  = "Redis from the tasks"
  referenced_security_group_id = aws_security_group.tasks.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}
