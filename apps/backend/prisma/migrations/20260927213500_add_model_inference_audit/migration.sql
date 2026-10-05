ALTER TABLE "DecisionEvent" ADD COLUMN "modelId" TEXT;
ALTER TABLE "DecisionEvent" ADD COLUMN "modelVersion" TEXT;
ALTER TABLE "DecisionEvent" ADD COLUMN "modelRunId" TEXT;
ALTER TABLE "DecisionEvent" ADD COLUMN "recommendation" TEXT;

ALTER TABLE "DecisionEvent" DROP CONSTRAINT "DecisionEvent_policyProbability_source_check";
ALTER TABLE "DecisionEvent" ADD CONSTRAINT "DecisionEvent_policyProbability_source_check" CHECK ("policyProbabilitySource" IS NULL OR "policyProbabilitySource" IN ('LOCAL_DEMONSTRATION', 'MODEL_API', 'MODEL_API_FALLBACK'));
ALTER TABLE "DecisionEvent" ADD CONSTRAINT "DecisionEvent_model_inference_snapshot_check" CHECK (COALESCE((
  ("policyProbabilitySource" = 'MODEL_API' AND "modelId" IS NOT NULL AND "modelVersion" IS NOT NULL AND "modelRunId" IS NOT NULL AND "policyProbability" IS NOT NULL AND "recommendation" IS NOT NULL)
  OR
  ("policyProbabilitySource" = 'MODEL_API_FALLBACK' AND "modelId" IS NULL AND "modelVersion" IS NULL AND "modelRunId" IS NULL AND "policyProbability" IS NULL AND "recommendation" = 'MANUAL_REVIEW')
  OR
  ("policyProbabilitySource" IS NULL AND "modelId" IS NULL AND "modelVersion" IS NULL AND "modelRunId" IS NULL AND "recommendation" IS NULL)
  OR
  ("policyProbabilitySource" = 'LOCAL_DEMONSTRATION' AND "modelId" IS NULL AND "modelVersion" IS NULL AND "modelRunId" IS NULL AND "recommendation" IS NULL)
), FALSE));
