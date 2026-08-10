module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.31"

  cluster_name    = var.cluster_name
  cluster_version = var.cluster_version

  # Public API endpoint so kubectl works from a laptop. Private-only is the
  # stricter choice and needs a bastion or VPN to administer; restrict by CIDR
  # instead if this is more than a demo.
  cluster_endpoint_public_access = true

  # Grants the identity running `terraform apply` cluster-admin through an EKS
  # access entry. Without it the cluster is created and immediately
  # unadministrable — the classic "you must be logged in to the server
  # (Unauthorized)" on the very first kubectl.
  enable_cluster_creator_admin_permissions = true

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  cluster_addons = {
    coredns    = {}
    kube-proxy = {}
    vpc-cni    = {}

    # Not installed by default, and its absence is silent: the in-tree EBS
    # provisioner was removed in Kubernetes 1.23, so without this addon the
    # `standard` StorageClass exists, PersistentVolumeClaims bind to nothing,
    # and Postgres, Redis and Elasticsearch sit Pending for ever.
    aws-ebs-csi-driver = {
      service_account_role_arn = module.ebs_csi_irsa.iam_role_arn
    }
  }

  eks_managed_node_groups = {
    default = {
      instance_types = [var.node_instance_type]
      capacity_type  = "ON_DEMAND"

      min_size     = var.node_group_size.min
      max_size     = var.node_group_size.max
      desired_size = var.node_group_size.desired

      # 50 GiB: fourteen container images plus their layers, plus kubelet's
      # image garbage collection headroom. The 20 GiB default runs the node out
      # of disk and triggers eviction of running pods.
      disk_size = 50

      # Lets nodes pull from ECR without a pull secret. The managed node group
      # gets ReadOnly by default; this is restated so removing it is a decision
      # rather than an accident.
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

# IRSA for the EBS CSI controller: the driver assumes this role through the
# cluster's OIDC provider rather than inheriting the node role. Attaching the
# policy to the node role would work and would also grant every pod on the node
# the ability to create and detach volumes.
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
