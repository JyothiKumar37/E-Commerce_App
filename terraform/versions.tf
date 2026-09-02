# Cluster infrastructure for the ecom platform.
#
#   cd terraform
#   cp terraform.tfvars.example terraform.tfvars     # then edit
#   terraform init
#   terraform apply
#
# Scope is deliberately the cluster and what it needs to exist: a VPC, EKS, a
# managed node group, the EBS CSI driver, and the ECR repositories the images
# are pushed to. Roughly 20 minutes, nearly all of it the control plane.
#
# It stops short of anything running INSIDE the cluster — no ingress controller,
# no Route 53 record, no application. Those are installed afterwards with helm
# and kubectl; `terraform output next_steps` prints the sequence.
#
# That boundary is worth keeping. Terraform managing in-cluster resources needs
# the kubernetes and helm providers configured from the cluster's own outputs,
# which are unknown until it exists — the source of the familiar "Provider
# configuration not known until apply" failure and the -target dance that
# follows. With only the AWS provider here, a single apply always works.
terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state, commented out because it needs a bucket that exists before the
  # first init. Local state is fine for one operator and fatal for two: there is
  # no locking, so a concurrent apply silently corrupts it.
  #
  #   aws s3api create-bucket --bucket ecom-tfstate-034768441662 \
  #     --region ap-south-1 \
  #     --create-bucket-configuration LocationConstraint=ap-south-1
  #   aws s3api put-bucket-versioning --bucket ecom-tfstate-034768441662 \
  #     --versioning-configuration Status=Enabled
  #
  # Versioning is the part people skip and later regret — it is the only way
  # back from a truncated or corrupted state file.
  #
  # backend "s3" {
  #   bucket       = "ecom-tfstate-034768441662"
  #   key          = "eks/terraform.tfstate"
  #   region       = "ap-south-1"
  #   encrypt      = true
  #   use_lockfile = true   # S3-native locking, Terraform >= 1.10; no DynamoDB table
  # }
}
