################################################################################
# Subnet group — RDS lives in the private subnets, same ones the nodes use.
################################################################################

resource "aws_db_subnet_group" "rds" {
  name        = "${var.cluster_name}-postgres"
  description = "Private subnets for the ${var.cluster_name} RDS PostgreSQL instance"
  subnet_ids  = module.vpc.private_subnets

  tags = var.tags
}

################################################################################
# Security group — reachable on 5432 from the EKS nodes only.
################################################################################

resource "aws_security_group" "rds" {
  name        = "${var.cluster_name}-rds"
  description = "Ingress to RDS PostgreSQL from the EKS node group only"
  vpc_id      = module.vpc.vpc_id

  tags = merge(var.tags, { Name = "${var.cluster_name}-rds" })
}

# The one rule that matters: source is the node shared security group, NOT a
# CIDR. Pods run on the nodes and egress through this SG, so this is the whole
# cluster and nothing else. No 0.0.0.0/0, no VPC-wide CIDR.
resource "aws_security_group_rule" "rds_ingress_from_nodes" {
  type                     = "ingress"
  description              = "PostgreSQL from EKS nodes"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  security_group_id        = aws_security_group.rds.id
  source_security_group_id = module.eks.node_security_group_id
}

resource "aws_security_group_rule" "rds_egress_all" {
  type              = "egress"
  description       = "Allow all egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  security_group_id = aws_security_group.rds.id
  cidr_blocks       = ["0.0.0.0/0"]
}

################################################################################
# Master password — generated, never hand-typed, never committed.
################################################################################

# IMPORTANT: an RDS master password may not contain '/', '@', '"', or spaces,
# and several other punctuation characters ('%', '#', '?', '&', ':', '<', '>')
# are fragile inside a postgres://user:pass@host/db URL once it is parsed by
# libpq / node-postgres. Restrict the generator to a conservative set that is
# unambiguous both for RDS and inside the URL the app assembles.
resource "random_password" "db" {
  length           = 32
  special          = true
  override_special = "!*()-_=+.,"
}

################################################################################
# The instance.
################################################################################

resource "aws_db_instance" "rds" {
  identifier     = "${var.cluster_name}-postgres"
  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  # --- Free-tier storage: 20 GB gp2, encrypted at rest ---
  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = 0 # 0 disables storage autoscaling, so it can't silently grow past the Free Tier
  storage_type          = "gp2"
  storage_encrypted     = true # uses the default aws/rds KMS key; cannot be changed after create

  # --- Database + master credentials ---
  db_name  = var.db_name
  username = var.db_username
  password = random_password.db.result
  port     = 5432

  # --- Placement + reachability ---
  db_subnet_group_name   = aws_db_subnet_group.rds.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  multi_az               = var.db_multi_az # false = Free Tier, single-AZ
  publicly_accessible    = false           # no public IP, cluster-only

  # --- Durability: automated backups + PITR ---
  backup_retention_period    = var.db_backup_retention_days # >= 1 enables PITR
  copy_tags_to_snapshot      = true
  auto_minor_version_upgrade = true

  # --- Demo lifecycle so `terraform destroy` is clean ---
  deletion_protection = var.db_deletion_protection # false for demo
  skip_final_snapshot = true                       # no final snapshot on destroy
  apply_immediately   = true                       # demo: don't wait for the maintenance window

  tags = var.tags
}
