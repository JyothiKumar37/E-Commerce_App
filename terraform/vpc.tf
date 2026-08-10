# Two availability zones, public and private subnets in each.
#
# Nodes sit in the private subnets and reach the internet through NAT; the load
# balancer sits in the public ones. Nothing in the cluster is directly
# addressable from the internet, which is the point.
locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.13"

  name = "${var.cluster_name}-vpc"
  cidr = var.vpc_cidr
  azs  = local.azs

  # /20 each: 4091 usable addresses. Generous for two nodes, and deliberately
  # so — the VPC CNI assigns every pod a real subnet address, so a busy cluster
  # exhausts IPs long before it exhausts CPU.
  private_subnets = [for i in range(length(local.azs)) : cidrsubnet(var.vpc_cidr, 4, i)]
  public_subnets  = [for i in range(length(local.azs)) : cidrsubnet(var.vpc_cidr, 4, i + 8)]

  enable_nat_gateway = true
  single_nat_gateway = var.single_nat_gateway

  # Required by the EKS-managed CoreDNS and by anything resolving private
  # endpoints; without them nodes come up but DNS inside the VPC does not work.
  enable_dns_hostnames = true
  enable_dns_support   = true

  # These tags are how the AWS cloud controller decides where to put a load
  # balancer for a Service of type LoadBalancer. Without the public tag the NLB
  # is created in private subnets and is unreachable from the internet, with no
  # error anywhere — the Service simply never gets a working address.
  public_subnet_tags = {
    "kubernetes.io/role/elb" = "1"
  }

  private_subnet_tags = {
    "kubernetes.io/role/internal-elb" = "1"
  }

  tags = var.tags
}
