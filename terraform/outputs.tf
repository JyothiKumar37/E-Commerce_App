output "cluster_name" {
  description = "EKS cluster name."
  value       = module.eks.cluster_name
}

output "cluster_endpoint" {
  description = "Kubernetes API endpoint."
  value       = module.eks.cluster_endpoint
}

output "cluster_version" {
  description = "Kubernetes minor version actually running."
  value       = module.eks.cluster_version
}

output "configure_kubectl" {
  description = "Point kubectl at the new cluster."
  value       = "aws eks update-kubeconfig --region ${var.region} --name ${module.eks.cluster_name}"
}

output "ecr_registry" {
  description = "Registry prefix for scripts/ecr-push.sh and scripts/set-images.sh."
  value       = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com/ecom"
}

output "vpc_id" {
  description = "VPC the cluster runs in."
  value       = module.vpc.vpc_id
}

output "public_subnet_ids" {
  description = "Public subnets. The internet-facing NLB for ingress-nginx is placed here, which is what the kubernetes.io/role/elb tag on them selects."
  value       = module.vpc.public_subnets
}

output "private_subnet_ids" {
  description = "Private subnets holding the nodes."
  value       = module.vpc.private_subnets
}

output "oidc_provider_arn" {
  description = "Cluster OIDC provider, for any further IRSA roles."
  value       = module.eks.oidc_provider_arn
}

output "next_steps" {
  description = "Everything Terraform deliberately does not do."
  value       = <<-EOT

    ── 1. kubectl ────────────────────────────────────────────────────
    aws eks update-kubeconfig --region ${var.region} --name ${module.eks.cluster_name}
    kubectl get nodes

    ── 2. Storage class ──────────────────────────────────────────────
    Names the EBS CSI driver installed above. Without it every PVC stays
    Pending on "storageclass standard not found".

    kubectl apply -f ../k8s/eks/storageclass.yaml

    ── 3. Ingress controller, with the ACM certificate ───────────────
    The ARN lives in the values file. TLS terminates at the NLB.

    helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
    helm repo update
    helm install ingress-nginx ingress-nginx/ingress-nginx \
      --namespace ingress-nginx --create-namespace \
      -f ../k8s/eks/ingress-nginx-values.yaml
    kubectl -n ingress-nginx rollout status deploy/ingress-nginx-controller --timeout=300s

    ── 4. DNS, in the console ────────────────────────────────────────
    Read the load balancer hostname:

      kubectl -n ingress-nginx get svc ingress-nginx-controller \
        -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'

    Route 53 -> your hosted zone -> Create record
      Record name : leave empty (the apex)
      Record type : A
      Alias       : on
      Route to    : Alias to Network Load Balancer -> ${var.region} -> pick it

    Network, not "Application and Classic" — the wrong dropdown will not
    list it. A CNAME cannot be used at an apex; the alias is what makes
    the bare domain work.

    ── 5. Images ─────────────────────────────────────────────────────
    AWS_REGION=${var.region} TAG=v1.0.0 VITE_API_URL=https://jeds.shop/api \
      bash ../scripts/ecr-push.sh
    bash ../scripts/set-images.sh ${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com/ecom v1.0.0

    VITE_API_URL is compiled into the storefront bundle and cannot be
    changed afterwards by any environment variable or ConfigMap.

    ── 6. Application ────────────────────────────────────────────────
    cp ../k8s/ecom-secrets.example.yaml ../k8s/ecom-secrets.yaml   # fill it in
    kubectl apply -f ../k8s/00-namespace.yaml -f ../k8s/ecom-secrets.yaml \
                  -f ../k8s/ecom-config-configmap.yaml
    kubectl apply -f ../k8s/postgres-data-persistentvolumeclaim.yaml \
                  -f ../k8s/redis-data-persistentvolumeclaim.yaml \
                  -f ../k8s/elastic-data-persistentvolumeclaim.yaml \
                  -f ../k8s/postgres-deployment.yaml -f ../k8s/postgres-service.yaml \
                  -f ../k8s/redis-deployment.yaml -f ../k8s/redis-service.yaml \
                  -f ../k8s/elasticsearch-deployment.yaml -f ../k8s/elasticsearch-service.yaml
    kubectl -n ecom wait --for=condition=available deploy/postgres deploy/redis --timeout=420s
    kubectl apply -f ../k8s/migrate-job.yaml
    kubectl -n ecom wait --for=condition=complete job/ecom-migrate --timeout=300s
    kubectl apply -f ../k8s/seed-job.yaml
    kubectl -n ecom wait --for=condition=complete job/ecom-seed --timeout=300s
    kubectl apply -f ../k8s/

    ── 7. Verify ─────────────────────────────────────────────────────
    curl -sI https://jeds.shop/ | head -1
    API_URL=https://jeds.shop/api node ../scripts/e2e.mjs
  EOT
}
