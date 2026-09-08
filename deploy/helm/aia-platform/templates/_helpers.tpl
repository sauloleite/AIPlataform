{{/* Nomes e labels padronizados. */}}

{{- define "aia.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "aia.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "aia.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "aia.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "aia.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: aia-platform
{{- end }}

{{- define "aia.selectorLabels" -}}
app.kubernetes.io/name: {{ include "aia.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* A service's image. */}}
{{- define "aia.image" -}}
{{- $tag := default .root.Chart.AppVersion .root.Values.global.imageTag -}}
{{- printf "%s/%s/%s:%s" .root.Values.global.imageRegistry .root.Values.global.imageRepository .service $tag -}}
{{- end }}

{{/*
The MongoDB URI.

Uses the in-chart StatefulSet when enabled, otherwise the external URI. Swapping
one for the other touches no service (ADR-012).
*/}}
{{- define "aia.mongoUri" -}}
{{- if .Values.mongodb.enabled -}}
mongodb://{{ .Release.Name }}-mongodb-headless:27017/?replicaSet=rs0
{{- else -}}
{{ required "With mongodb.enabled=false, set mongodb.externalUri" .Values.mongodb.externalUri }}
{{- end -}}
{{- end }}

{{- define "aia.redisUrl" -}}
{{- if .Values.redis.enabled -}}
redis://{{ .Release.Name }}-redis-master:6379
{{- else -}}
{{ required "With redis.enabled=false, set redis.externalUri" .Values.redis.externalUri }}
{{- end -}}
{{- end }}

{{- define "aia.identityUrl" -}}
http://{{ include "aia.fullname" . }}-identity:{{ .Values.identity.port }}
{{- end }}

{{- define "aia.governanceUrl" -}}
http://{{ include "aia.fullname" . }}-governance:{{ .Values.governance.port }}
{{- end }}

{{- define "aia.guardrailsUrl" -}}
http://{{ include "aia.fullname" . }}-guardrails:{{ .Values.guardrails.port }}
{{- end }}

{{- define "aia.routerUrl" -}}
http://{{ include "aia.fullname" . }}-inference-router:{{ .Values.inferenceRouter.port }}
{{- end }}

{{- define "aia.registryUrl" -}}
http://{{ include "aia.fullname" . }}-registry:{{ .Values.registry.port }}
{{- end }}

{{- define "aia.knowledgeUrl" -}}
http://{{ include "aia.fullname" . }}-knowledge:{{ .Values.knowledge.port }}
{{- end }}

{{- define "aia.mcpGatewayUrl" -}}
http://{{ include "aia.fullname" . }}-mcp-gateway:{{ .Values.mcpGateway.port }}
{{- end }}

{{- define "aia.qdrantUrl" -}}
{{- if .Values.qdrant.enabled -}}
http://{{ include "aia.fullname" . }}-qdrant:6333
{{- else -}}
{{ required "With qdrant.enabled=false, set qdrant.externalUrl" .Values.qdrant.externalUrl }}
{{- end -}}
{{- end }}

{{- define "aia.minioUrl" -}}
{{- if .Values.minio.enabled -}}
http://{{ include "aia.fullname" . }}-minio:9000
{{- else -}}
{{ required "With minio.enabled=false, set minio.externalUrl" .Values.minio.externalUrl }}
{{- end -}}
{{- end }}

{{/*
  Environment for aia-knowledge and for its ingestion worker.

  Shared because they are the same image with a different command: a variable
  present in one and missing from the other is how a worker silently indexes
  into a different bucket than the API reads from.
*/}}
{{- define "aia.knowledgeEnv" -}}
- name: MONGO_DATABASE
  value: aia_knowledge
- name: QDRANT_URL
  value: {{ include "aia.qdrantUrl" . | quote }}
- name: MINIO_ENDPOINT
  value: {{ include "aia.minioUrl" . | quote }}
- name: KNOWLEDGE_BUCKET
  value: {{ .Values.minio.bucket | quote }}
- name: INFERENCE_ROUTER_URL
  value: {{ include "aia.routerUrl" . | quote }}
- name: EMBEDDING_BATCH_SIZE
  value: {{ .Values.knowledge.embeddingBatchSize | quote }}
- name: DOCUMENT_PROCESSING_URL
  value: {{ .Values.knowledge.documentProcessingUrl | quote }}
{{- if .Values.minio.existingSecret }}
- name: MINIO_ROOT_USER
  valueFrom:
    secretKeyRef: { name: {{ .Values.minio.existingSecret }}, key: root-user }
- name: MINIO_ROOT_PASSWORD
  valueFrom:
    secretKeyRef: { name: {{ .Values.minio.existingSecret }}, key: root-password }
{{- end }}
{{- end }}

{{- define "aia.ollamaUrl" -}}
{{- if .Values.ollama.enabled -}}
http://{{ include "aia.fullname" . }}-ollama:11434
{{- else -}}
{{ .Values.ollama.externalUrl | default "" }}
{{- end -}}
{{- end }}

{{/* Environment shared by every platform service. */}}
{{- define "aia.commonEnv" -}}
- name: NODE_ENV
  value: production
- name: MONGO_URI
  value: {{ include "aia.mongoUri" . | quote }}
- name: REDIS_URL
  value: {{ include "aia.redisUrl" . | quote }}
- name: IDENTITY_ISSUER
  value: {{ .Values.identity.issuer | quote }}
- name: IDENTITY_AUDIENCE
  value: {{ .Values.identity.audience | quote }}
- name: IDENTITY_JWKS_URL
  value: {{ printf "%s/.well-known/jwks.json" (include "aia.identityUrl" .) | quote }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ .Values.telemetry.otlpEndpoint | quote }}
- name: AIA_CONTENT_CAPTURE
  value: {{ .Values.telemetry.contentCapture | quote }}
{{- end }}

{{/* Volumes de escrita. readOnlyRootFilesystem exige /tmp montado. */}}
{{- define "aia.tmpVolume" -}}
- name: tmp
  emptyDir: {}
{{- end }}

{{- define "aia.tmpVolumeMount" -}}
- name: tmp
  mountPath: /tmp
{{- end }}
