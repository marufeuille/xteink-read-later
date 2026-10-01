variable "account_id" {
  type        = string
  description = "Cloudflare account ID。値の例は terraform.tfvars.example。API トークンは渡さない。"

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "account_id は 32 文字の 16 進（Cloudflare の Account ID）にする。"
  }
}

variable "policy_precedence" {
  type        = number
  description = "Allow と Bypass の両方に付くポリシーの順序。2026-09-30 の読み取りでは未記録。Access の先頭は通常 1。plan が precedence だけを出すとき、terraform.tfvars で実体の値に合わせ、その差分は apply しない。"
  default     = 1
}
