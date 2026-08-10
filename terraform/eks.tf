################################################################################
# Cluster
################################################################################

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.31"

  cluster_name    = var.cluster_name
  cluster_version = var.cluster_version

  # Public API endpoint so kubectl and the console work from outside the VPC.
  # Private-only is stricter but needs a bastion or VPN to administer at all;
  # restricting by CIDR is the middle ground.
  cluster_endpoint_public_access       = true
  cluster_endpoint_public_access_cidrs = var.cluster_endpoint_public_access_cidrs

  # Grants the identity running `terraform apply` cluster-admin through an EKS
  # access entry. Without it the cluster is created and immediately
  # unadministrable — the familiar "you must be logged in to the server
  # (Unauthorized)" on the very first kubectl.
  enable_cluster_creator_admin_permissions = true

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  # Closes a gap in the module's recommended rules.
  #
  # Those allow node-to-node TCP on 1025-65535 only — "ephemeral ports". Pods
  # listening below 1025 are therefore unreachable from a pod on another node,
  # and the storefront is nginx on port 80.
  #
  # The symptom is worth recognising because it does not look like a firewall.
  # Traffic to the API on 8080 works, so the cluster appears healthy; only the
  # storefront fails, and only when the ingress controller and the web pod
  # happen to be scheduled on different nodes. With two replicas of each that is
  # roughly half the time, so it presents as flakiness rather than as a rule.
  # In the controller log it reads:
  #
  #   upstream timed out (110: Operation timed out) while connecting to
  #   upstream, request: "HEAD / HTTP/1.1", upstream: "http://10.0.0.171:80/"
  #
  # "while connecting" is the tell — nginx never got a TCP connection, so
  # nothing reached the application to fail.
  #
  # This is node-to-node within one security group, which is where Kubernetes
  # expects pod traffic to be unrestricted; per-pod restriction belongs in a
  # NetworkPolicy, not here.
  node_security_group_additional_rules = {
    ingress_self_privileged_ports = {
      description = "Node to node, ports below 1025"
      protocol    = "tcp"
      from_port   = 1
      to_port     = 1024
      type        = "ingress"
      self        = true
    }
  }

  # Addons are declared below as first-class resources rather than through this
  # module's `cluster_addons` input. See the note above aws_eks_addon.this.
  cluster_addons = {}

  eks_managed_node_groups = {
    default = {
      instance_types = [var.node_instance_type]
      capacity_type  = "ON_DEMAND"

      min_size     = var.node_group_size.min
      max_size     = var.node_group_size.max
      desired_size = var.node_group_size.desired

      disk_size = var.node_disk_size

      # One node at a time during an AMI or version upgrade. The default of 33%
      # would take both nodes out together on a two-node group, and the
      # application's PodDisruptionBudgets — minAvailable 1 against two
      # replicas — would block the second drain until the first node came back.
      # Explicit here so the behaviour does not change with the group size.
      update_config = {
        max_unavailable = 1
      }

      # Lets nodes pull from ECR without a pull secret. Managed node groups get
      # this by default; restating it makes removing it a decision rather than
      # an accident.
      iam_role_additional_policies = {
        ecr = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
      }

      labels = {
        workload = "ecom"
      }
    }
  }

  tags = var.tags
}

################################################################################
# Addons
################################################################################

# Declared here rather than through the module's `cluster_addons` input.
#
# The module's `cluster_addons` output is `merge(aws_eks_addon.this, ...)`,
# which exports each addon's whole resource object. `resolve_conflicts` is still
# in the provider's aws_eks_addon schema and is deprecated, so Terraform 1.13
# emits a deprecation warning for every addon — even though the module never
# sets the attribute and its value is null. Reading the object is enough.
#
# Moving the addons out leaves that output an empty map, so nothing traverses
# the deprecated attribute. The warning is cosmetic, but the explicitness is
# worth having on its own: version, conflict policy and IAM role for each addon
# are visible here instead of inferred from a module's defaults.
#
# Safe on a cluster that already exists. The module sets `preserve = true`, so
# removing its addon resources leaves the addon software running, and
# `resolve_conflicts_on_create = "OVERWRITE"` below adopts it rather than
# failing with ResourceInUseException.
locals {
  cluster_addons = {
    vpc-cni    = {}
    kube-proxy = {}
    coredns    = {}

    # Not installed by default, and its absence is silent: the in-tree EBS
    # provisioner was removed in Kubernetes 1.23, so without this the
    # `standard` StorageClass exists, every PersistentVolumeClaim binds to
    # nothing, and Postgres, Redis and Elasticsearch sit Pending indefinitely.
    aws-ebs-csi-driver = {
      service_account_role_arn = module.ebs_csi_irsa.iam_role_arn
    }
  }
}

# The default version AWS ships for this Kubernetes version, not the newest
# available. Default versions change only when cluster_version changes, so an
# apply for an unrelated reason cannot quietly upgrade CoreDNS underneath a
# running cluster. Set most_recent = true to track the latest instead — the plan
# shows the version change either way, but only one of those is predictable.
data "aws_eks_addon_version" "this" {
  for_each = local.cluster_addons

  addon_name         = each.key
  kubernetes_version = module.eks.cluster_version
}

resource "aws_eks_addon" "this" {
  for_each = local.cluster_addons

  cluster_name  = module.eks.cluster_name
  addon_name    = each.key
  addon_version = data.aws_eks_addon_version.this[each.key].version

  service_account_role_arn = try(each.value.service_account_role_arn, null)

  # EKS bootstraps self-managed copies of vpc-cni, kube-proxy and coredns when
  # the cluster is created. OVERWRITE converts those into managed addons instead
  # of failing on the conflict.
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  # Leave the software running if the addon resource is ever removed from
  # Terraform. Deleting the vpc-cni addon for real takes pod networking with it.
  preserve = true

  # The whole module, so the node group exists first. CoreDNS has nowhere to
  # schedule on a cluster with no nodes and reports DEGRADED until one appears.
  depends_on = [module.eks]

  tags = var.tags
}

################################################################################
# IRSA
################################################################################

# The EBS CSI controller assumes this role through the cluster's OIDC provider.
# Attaching the policy to the node role instead would work, and would also give
# every pod on the node the ability to create and detach volumes.
module "ebs_csi_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.44"

  role_name             = "${var.cluster_name}-ebs-csi-driver"
  attach_ebs_csi_policy = true

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:ebs-csi-controller-sa"]
    }
  }

  tags = var.tags
}
