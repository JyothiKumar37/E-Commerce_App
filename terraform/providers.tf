provider "aws" {
  region = var.region

  default_tags {
    tags = var.tags
  }
}

# The Kubernetes and Helm providers authenticate with a short-lived token
# fetched by the AWS CLI at apply time, rather than a long-lived one baked into
# state. An EKS token lasts 15 minutes; embedding one would expire mid-apply and
# leave it in the state file besides.
#
# `aws` must therefore be on PATH wherever Terraform runs, including CI.
provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)

  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name, "--region", var.region]
  }
}

provider "helm" {
  kubernetes {
    host                   = module.eks.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)

    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name, "--region", var.region]
    }
  }
}

data "aws_availability_zones" "available" {
  state = "available"

  # Local Zones and Wavelength Zones cannot host EKS nodes and would break
  # subnet placement if they came back in the list.
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

data "aws_caller_identity" "current" {}
