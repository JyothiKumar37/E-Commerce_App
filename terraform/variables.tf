variable "region" {
  description = "AWS region. Must match the region of the ACM certificate that will be attached to the load balancer later — a certificate is regional and invisible to a load balancer elsewhere."
  type        = string
  default     = "ap-south-1"
}

variable "cluster_name" {
  description = "EKS cluster name, and the prefix for nearly every resource here."
  type        = string
  default     = "ecom"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,37}$", var.cluster_name))
    error_message = "Lowercase letters, digits and hyphens, starting with a letter, 38 characters or fewer."
  }
}

variable "cluster_version" {
  description = "Kubernetes minor version. EKS supports each for about 14 months before extended-support charges begin."
  type        = string
  default     = "1.31"

  validation {
    condition     = can(regex("^1\\.(2[7-9]|3[0-9])$", var.cluster_version))
    error_message = "Expected a supported EKS minor version, for example 1.31."
  }
}

variable "node_instance_type" {
  description = "Instance type for the managed node group."
  type        = string
  default     = "m7i-flex.large"
}

variable "node_group_size" {
  description = "Desired, minimum and maximum node count. Two is the floor for this workload: the stateless tier runs two replicas with anti-affinity and PodDisruptionBudgets of minAvailable 1, so on one node a drain has nowhere to move a pod and blocks."
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

variable "node_disk_size" {
  description = "Root volume per node, in GiB. Fourteen container images and their layers, plus headroom for kubelet's image garbage collection; the 20 GiB default runs out and starts evicting running pods."
  type        = number
  default     = 50

  validation {
    condition     = var.node_disk_size >= 30
    error_message = "At least 30 GiB — smaller fills up once the images are pulled."
  }
}

variable "vpc_cidr" {
  description = "CIDR for the VPC. The VPC CNI gives every pod a real subnet address, so address space runs out long before CPU does — do not size this to the node count."
  type        = string
  default     = "10.0.0.0/16"

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr)) && tonumber(split("/", var.vpc_cidr)[1]) <= 18
    error_message = "Must be a valid CIDR of /18 or larger."
  }
}

variable "single_nat_gateway" {
  description = "Route all private egress through one NAT gateway. True saves about $32/month per AZ avoided and makes that AZ a shared dependency for outbound traffic. False is the production answer; true is the honest one for a demo."
  type        = bool
  default     = true
}

variable "cluster_endpoint_public_access_cidrs" {
  description = "Who may reach the Kubernetes API. The default is open, which is what the AWS console and a laptop on a changing IP need. Narrow it to an office or VPN range if this becomes more than a demo."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "tags" {
  description = "Applied to everything that supports tagging."
  type        = map(string)
  default = {
    Project   = "ecom"
    ManagedBy = "terraform"
  }
}

variable "db_instance_class" {
  description = "RDS instance class. db.t4g.micro (ARM/Graviton) is free-tier eligible and cheaper than the x86 db.t3.micro; both qualify for the 750 free instance-hours/month."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "Storage in GiB. 20 is the Free Tier ceiling for gp2 general-purpose SSD."
  type        = number
  default     = 20

  validation {
    condition     = var.db_allocated_storage <= 20
    error_message = "Keep at or below 20 GiB to stay in the Free Tier."
  }
}

variable "db_engine_version" {
  description = "PostgreSQL engine version. Matches the in-cluster major (postgres:16.3-alpine). Pin to an available 16.x minor; verify with `aws rds describe-db-engine-versions --engine postgres`."
  type        = string
  default     = "16.15"
}

variable "db_backup_retention_days" {
  description = "Automated backup retention. Any value >= 1 enables point-in-time recovery; The newer AWS Free Tier (Free Plan) caps this below the classic 7-day allowance, so the default is 1 day; a paid plan supports up to 35 for a longer PITR window."
  type        = number
  default     = 1

  validation {
    condition     = var.db_backup_retention_days >= 1
    error_message = "Must be >= 1 so PITR is enabled."
  }
}

variable "db_name" {
  description = "Initial database name. Matches the in-cluster POSTGRES_DB."
  type        = string
  default     = "ecom"
}

variable "db_username" {
  description = "Master username. Matches the in-cluster POSTGRES_USER."
  type        = string
  default     = "ecom"
}

variable "db_multi_az" {
  description = "Multi-AZ standby. FALSE for the Free Tier — Multi-AZ doubles the instance cost. See the cost notes; this is the future paid HA upgrade."
  type        = bool
  default     = false
}

variable "db_deletion_protection" {
  description = "Block accidental deletion. false for a demo so `terraform destroy` works; turn on for anything holding real data."
  type        = bool
  default     = false
}
