{{/*
公共命名与标签（TP-5-09）。

服务名用 kebab-case（`generation-worker`），而 values 里的键是 camelCase
（`generationWorker`）—— Helm 的 map 键不能带连字符地被 `.Values.services.x`
访问，因此在这里转换一次，而不是让每个模板各自处理。
*/}}

{{- define "tps.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "tps.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "tps.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "tps.labels" -}}
app.kubernetes.io/name: {{ include "tps.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "tps.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "tps.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
camelCase → kebab-case。`generationWorker` → `generation-worker`，
与镜像名、容器名、Deployment 名一致。
*/}}
{{- define "tps.kebab" -}}
{{- regexReplaceAll "([a-z0-9])([A-Z])" . "${1}-${2}" | lower -}}
{{- end -}}
