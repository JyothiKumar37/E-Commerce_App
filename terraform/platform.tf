# The ingress layer. Terraform owns this because the Route 53 record below
# cannot be written until the load balancer it points at exists, and that load
# balancer is created by Kubernetes in response to this Helm release.

# The certificate is looked up rather than hardcoded, so rotating or replacing
# it is an ACM operation with no Terraform change. It must be ISSUED and in
# var.region — a certificate elsewhere is invisible to a load balancer here, and
# the listener is then created without TLS rather than failing.
data "aws_acm_certificate" "site" {
  domain      = var.domain_name
  statuses    = ["ISSUED"]
  most_recent = true
}

resource "helm_release" "ingress_nginx" {
  name             = "ingress-nginx"
  repository       = "https://kubernetes.github.io/ingress-nginx"
  chart            = "ingress-nginx"
  version          = "4.11.3"
  namespace        = "ingress-nginx"
  create_namespace = true

  # Helm reports success once the chart is applied. wait makes it block until
  # the controller pods are actually Ready, which is what the load balancer
  # lookup below depends on.
  wait    = true
  timeout = 600

  values = [
    templatefile("${path.module}/templates/ingress-nginx-values.yaml.tftpl", {
      certificate_arn = data.aws_acm_certificate.site.arn
      replica_count   = 2
    })
  ]

  depends_on = [module.eks]
}

# The controller pods being Ready is not the same as the NLB being provisioned:
# the cloud controller reconciles the Service afterwards, and the load balancer
# takes another minute or two to appear. Without this pause the data source
# below fails with "no matching LB found" on a first apply, and succeeds on the
# second — the kind of intermittent failure that wastes an afternoon.
resource "time_sleep" "wait_for_load_balancer" {
  depends_on      = [helm_release.ingress_nginx]
  create_duration = "120s"
}

# Found by the tag the AWS cloud controller stamps on every load balancer it
# creates for a Service. Matching on name is not possible: the name is generated
# and appears nowhere in Terraform's configuration.
data "aws_lb" "ingress" {
  tags = {
    "kubernetes.io/service-name" = "ingress-nginx/ingress-nginx-controller"
  }

  depends_on = [time_sleep.wait_for_load_balancer]
}
