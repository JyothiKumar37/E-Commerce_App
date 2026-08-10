data "aws_route53_zone" "this" {
  name         = coalesce(var.hosted_zone_name, var.domain_name)
  private_zone = false
}

# An A record with an alias target, not a CNAME.
#
# A CNAME is illegal at a zone apex — the RFCs forbid it coexisting with the SOA
# and NS records every zone must have — which is why the same domain could not
# be pointed at a load balancer from a registrar's own DNS. Route 53's alias is
# an AWS extension that resolves to the load balancer's addresses while
# remaining an A record, so the apex works.
#
# Alias queries to an AWS resource are also not billed, unlike ordinary ones.
resource "aws_route53_record" "apex" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = data.aws_lb.ingress.dns_name
    zone_id                = data.aws_lb.ingress.zone_id
    evaluate_target_health = true
  }
}

# No www record, deliberately.
#
# CORS_ORIGINS in k8s/ecom-config-configmap.yaml names exactly one origin,
# because the API sends a credentialed cookie and the browser forbids a wildcard
# for those. A second hostname resolving here would render pages — GETs carry no
# Origin header — and reject every POST with 403. Serving www means a redirect
# to the apex, not a second address for the same site.
