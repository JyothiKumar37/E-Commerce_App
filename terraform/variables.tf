variable "region" {
  description = "AWS region. Must match the region of the ACM certificate — a certificate is regional and cannot be attached to a load balancer elsewhere."
  type        = string
  default     = "ap-south-1"
}

variable "cluster_name" {
  description = "EKS cluster name. Used as the prefix for nearly every resource here."
  type        = string
  default     = "ecom"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,37}$", var.cluster_name))
    error_message = "Lowercase letters, digits and hyphens, starting with a letter, 38 characters or fewer."
  }
}

variable "cluster_version" {
  description = "Kubernetes minor version. EKS supports each for about 14 months; check the release calendar before pinning something old."
  type        = string
  default     = "1.31"
}

variable "domain_name" {
  description = "Public hostname the storefront answers on. A Route 53 public hosted zone for it must already exist, as must an ISSUED ACM certificate covering it."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]*\\.[a-z]{2,}$", var.domain_name))
    error_message = "A bare hostname, no scheme and no trailing dot: jeds.shop"
  }
}

variable "hosted_zone_name" {
  description = "Route 53 hosted zone to create the record in. Defaults to domain_name, which is right when the domain is an apex; set it explicitly for a subdomain (app.example.com lives in the example.com zone)."
  type        = string
  default     = ""
}

variable "node_instance_type" {
  description = "Instance type for the managed node group."
  type        = string
  default     = "m7i-flex.large"
}

variable "node_group_size" {
  description = "Desired, minimum and maximum node count. Two is the floor for the workload here: the stateless tier runs two replicas with anti-affinity, and a single node leaves every second replica sharing a fate with the first."
  type = object({
    desired = number
    min     = number
    max     = number
  })
  default = {
    desired = 2
    min     = 2
    max     = 4
  }

  validation {
    condition     = var.node_group_size.min <= var.node_group_size.desired && var.node_group_size.desired <= var.node_group_size.max
    error_message = "Requires min <= desired <= max."
  }
}

variable "vpc_cidr" {
  description = "CIDR for the VPC. /16 leaves room for the /20 subnets carved below and for the pod IPs the VPC CNI hands out — every pod gets a real VPC address, so subnets run out of space far sooner than node count suggests."
  type        = string
  default     = "10.0.0.0/16"

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr)) && tonumber(split("/", var.vpc_cidr)[1]) <= 18
    error_message = "Must be a valid CIDR of /18 or larger."
  }
}

variable "single_nat_gateway" {
  description = "Route all private egress through one NAT gateway. True saves about $32/month per AZ avoided and makes that AZ a single point of failure for outbound traffic. False is the production answer; true is the honest one for a demo."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Applied to everything that supports tagging."
  type        = map(string)
  default = {
    Project   = "ecom"
    ManagedBy = "terraform"
  }
}
