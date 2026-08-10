# Only the AWS provider. Nothing here talks to the Kubernetes API, which is what
# keeps a single `terraform apply` reliable — see the note in versions.tf.
provider "aws" {
  region = var.region

  default_tags {
    tags = var.tags
  }
}

data "aws_availability_zones" "available" {
  state = "available"

  # Local Zones and Wavelength Zones cannot host EKS nodes and would break
  # subnet placement if they appeared in the list.
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

data "aws_caller_identity" "current" {}
