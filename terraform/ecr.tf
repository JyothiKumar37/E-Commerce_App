# One repository per image. ECR has no notion of a namespace, so the slash in
# `ecom/search` is simply part of the repository name.
locals {
  ecr_repositories = [
    "api-gateway",
    "account",
    "cart",
    "inventory",
    "order-status",
    "payment",
    "place-order",
    "product-review",
    "recommendation",
    "recommendation-generation",
    "search",
    "shipping",
    "database",
    "web",
  ]
}

resource "aws_ecr_repository" "this" {
  for_each = var.create_ecr_repositories ? toset(local.ecr_repositories) : toset([])

  name = "ecom/${each.value}"

  # MUTABLE, which is why the manifests use imagePullPolicy: Always. Pushing a
  # rebuilt image over the same tag is the normal loop here. Switch to IMMUTABLE
  # and give every build a unique tag when releases matter more than iteration
  # speed — a mutable tag makes "which image is running" unanswerable.
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  # Repositories hold no state worth keeping; force_delete lets `terraform
  # destroy` remove them without a manual pass to delete every image first.
  force_delete = true

  tags = var.tags
}

# Untagged layers accumulate on every rebuild of a mutable tag and are billed
# like everything else. Nothing can run them, so there is no reason to keep them.
resource "aws_ecr_lifecycle_policy" "expire_untagged" {
  for_each = aws_ecr_repository.this

  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Expire untagged images after 7 days"
      selection = {
        tagStatus   = "untagged"
        countType   = "sinceImagePushed"
        countUnit   = "days"
        countNumber = 7
      }
      action = { type = "expire" }
    }]
  })
}
