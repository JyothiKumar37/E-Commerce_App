output "cluster_name" {
  description = "EKS cluster name."
  value       = module.eks.cluster_name
}

output "cluster_endpoint" {
  description = "Kubernetes API endpoint."
  value       = module.eks.cluster_endpoint
}

output "configure_kubectl" {
  description = "Point kubectl at the new cluster."
  value       = "aws eks update-kubeconfig --region ${var.region} --name ${module.eks.cluster_name}"
}

output "ecr_registry" {
  description = "Registry prefix for scripts/set-images.sh and scripts/ecr-push.sh."
  value       = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com/ecom"
}

output "load_balancer_hostname" {
  description = "NLB in front of ingress-nginx. The apex record aliases to this."
  value       = data.aws_lb.ingress.dns_name
}

output "site_url" {
  description = "Where the storefront answers once the application manifests are applied."
  value       = "https://${var.domain_name}"
}

output "certificate_arn" {
  description = "ACM certificate attached to the NLB listener."
  value       = data.aws_acm_certificate.site.arn
}

# Everything needed to deploy the application, in the order it has to happen.
output "next_steps" {
  description = "Application deployment, which Terraform deliberately does not do."
  value       = <<-EOT

    1. kubectl:
       aws eks update-kubeconfig --region ${var.region} --name ${module.eks.cluster_name}

    2. Storage class (names the EBS CSI driver installed above):
       kubectl apply -f ../k8s/eks/storageclass.yaml

    3. Images:
       AWS_REGION=${var.region} TAG=v1.0.0 VITE_API_URL=https://${var.domain_name}/api \
         bash ../scripts/ecr-push.sh
       bash ../scripts/set-images.sh ${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com/ecom v1.0.0

    4. Secrets — generate fresh ones, do not reuse another cluster's:
       cp ../k8s/ecom-secrets.example.yaml ../k8s/ecom-secrets.yaml

    5. Infrastructure, then schema, then the rest:
       kubectl apply -f ../k8s/00-namespace.yaml -f ../k8s/ecom-secrets.yaml
       kubectl apply -f ../k8s/ecom-config-configmap.yaml
       kubectl apply -f ../k8s/postgres-deployment.yaml -f ../k8s/postgres-service.yaml \
                       -f ../k8s/redis-deployment.yaml -f ../k8s/redis-service.yaml \
                       -f ../k8s/elasticsearch-deployment.yaml -f ../k8s/elasticsearch-service.yaml \
                       -f ../k8s/postgres-data-persistentvolumeclaim.yaml \
                       -f ../k8s/redis-data-persistentvolumeclaim.yaml \
                       -f ../k8s/elastic-data-persistentvolumeclaim.yaml
       kubectl -n ecom wait --for=condition=available deploy/postgres deploy/redis --timeout=420s
       kubectl apply -f ../k8s/migrate-job.yaml
       kubectl -n ecom wait --for=condition=complete job/ecom-migrate --timeout=300s
       kubectl apply -f ../k8s/seed-job.yaml
       kubectl apply -f ../k8s/

    6. Verify:
       API_URL=https://${var.domain_name}/api node ../scripts/e2e.mjs
  EOT
}
