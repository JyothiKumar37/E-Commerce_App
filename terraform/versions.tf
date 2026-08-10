# Infrastructure for the ecom platform on EKS.
#
#   cd terraform
#   cp terraform.tfvars.example terraform.tfvars     # then edit
#   terraform init
#   terraform apply
#
# Roughly 20 minutes, most of it the EKS control plane. What comes out:
# a VPC, a two-node cluster, the fourteen ECR repositories, ingress-nginx
# fronted by an NLB carrying the ACM certificate, and an apex A/ALIAS record
# for the domain.
#
# It stops at the platform boundary. The application's own manifests stay in
# k8s/ and are applied with kubectl — Terraform is a poor fit for objects that
# change every deploy, and putting them here would mean a plan/apply cycle to
# ship a container image.
terraform {
  required_version = ">= 1.5"

  required_providers {
    aws        = { source = "hashicorp/aws", version = "~> 5.70" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.33" }
    # Pinned to 2.x deliberately: the 3.0 provider replaced the nested
    # `kubernetes { }` block with an attribute, so providers.tf would not parse.
    helm = { source = "hashicorp/helm", version = "~> 2.16" }
    time = { source = "hashicorp/time", version = "~> 0.12" }
  }

  # Remote state, commented out because it needs a bucket that exists before
  # the first init. Local state is fine for one operator and fatal for two:
  # there is no locking, so a concurrent apply silently corrupts it.
  #
  #   aws s3api create-bucket --bucket ecom-tfstate-<account-id> \
  #     --region ap-south-1 --create-bucket-configuration LocationConstraint=ap-south-1
  #   aws s3api put-bucket-versioning --bucket ecom-tfstate-<account-id> \
  #     --versioning-configuration Status=Enabled
  #
  # Versioning is the part people skip and regret: it is the only way back from
  # a corrupted or truncated state file.
  #
  # backend "s3" {
  #   bucket       = "ecom-tfstate-034768441662"
  #   key          = "eks/terraform.tfstate"
  #   region       = "ap-south-1"
  #   encrypt      = true
  #   use_lockfile = true   # S3-native locking, Terraform >= 1.10; no DynamoDB table
  # }
}
