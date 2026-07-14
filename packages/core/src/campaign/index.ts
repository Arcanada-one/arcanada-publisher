export { ManagedTargetRegistry } from "./registry.js";
export type { RegistryLoadOptions, ManagedTargetRequest } from "./registry.js";
export {
  ArticleCampaignManifestSchema,
  ManagedTargetRegistrySchema,
  loadCampaignManifest,
  canonicalJson,
  sha256,
} from "./types.js";
export type {
  ArticleCampaignManifest,
  CampaignDestination,
  LoadedCampaignManifest,
  ManagedTarget,
} from "./types.js";
export { validateArticleCampaign, validateBacklinkPreflight } from "./article-policy.js";
export type {
  ArticleValidationEvidence,
  ArtifactEvidence,
  CampaignFinding,
  UrlEvidence,
} from "./article-policy.js";
export { issueReceipt, parseReceipt, verifyReceipt, ReceiptLedger } from "./receipt.js";
export type {
  CampaignPublicAction,
  CampaignReceiptEnvelope,
  CampaignReceiptPayload,
  ReceiptBinding,
  ReceiptCryptoOptions,
} from "./receipt.js";
export { CampaignGuard } from "./guard.js";
export type {
  CampaignAuthorization,
  CampaignGuardOptions,
  CampaignMutationInput,
} from "./guard.js";
export { setupCampaignPolicy, deEnrollCampaignPolicy } from "./setup.js";
export type { CampaignPolicyDeenrollOptions, CampaignPolicySetupOptions } from "./setup.js";
