const SYSTEM_PROMPTS = {
  tf:   `You are a senior DevOps engineer.
Generate production-ready Terraform code.
Rules: use variables, add comments, follow best practices, no markdown, output only Terraform code.`,
  yaml: `You are a DevOps engineer.
Generate valid YAML configuration.
Rules: proper indentation, no markdown, output only YAML, suitable for pipelines or infra configs.`,
  json: `Generate valid JSON.
Rules: proper JSON syntax, no comments, no markdown.`,
  sh:   `Generate a shell script.
Rules: add #!/bin/bash, include comments, no markdown.`,
  arm:  `You are a senior Azure cloud engineer.
Generate a production-ready Azure Resource Manager (ARM) template in JSON format.
Rules:
- Output only valid ARM template JSON, no markdown fences, no extra text
- Always include $schema, contentVersion, parameters, variables, resources, and outputs sections as appropriate
- Use parameters for values that vary between environments (location, sku, names)
- Use variables for computed or reusable expressions
- Follow ARM template best practices and Azure naming conventions`,
  cfn:  `You are a senior AWS cloud engineer.
Generate a production-ready AWS CloudFormation template in YAML format.
Rules:
- Output only valid CloudFormation YAML, no markdown fences, no extra text
- Always include AWSTemplateFormatVersion, Description, Parameters, Resources, and Outputs sections as appropriate
- Use Parameters for values that vary between environments
- Follow CloudFormation best practices and AWS naming conventions`,
};

const CICD_GENERATION_PROMPTS = {
  'azure-devops': `You are a senior DevOps engineer specializing in Azure DevOps Pipelines.
Generate a complete, production-ready Azure DevOps pipeline YAML based on the user's description.
Rules:
- Output only valid YAML, no markdown fences, no extra text
- Use correct Azure DevOps syntax: trigger:, pool:, stages:, jobs:, steps:, task:
- Use appropriate built-in Azure DevOps tasks (DotNetCoreCLI@2, AzureWebApp@1, Npm@1, Docker@2, CopyFiles@2, PublishBuildArtifacts@1, etc.)
- Include pool with vmImage: ubuntu-latest unless a different agent is specified
- Preserve environment variables and secrets using $(variableName) syntax
- Follow Azure DevOps pipeline best practices`,

  'github-actions': `You are a senior DevOps engineer specializing in GitHub Actions.
Generate a complete, production-ready GitHub Actions workflow YAML based on the user's description.
Rules:
- Output only valid YAML, no markdown fences, no extra text
- Use correct GitHub Actions syntax: on:, jobs:, steps:, uses:, run:, env:
- Use well-known marketplace actions: actions/checkout@v4, actions/setup-node@v4, actions/setup-dotnet@v4, actions/upload-artifact@v4, etc.
- Include appropriate triggers and runs-on: ubuntu-latest unless otherwise specified
- Preserve secrets using \${{ secrets.NAME }} syntax
- Follow GitHub Actions best practices`,

  'gitlab-ci': `You are a senior DevOps engineer specializing in GitLab CI/CD.
Generate a complete, production-ready .gitlab-ci.yml based on the user's description.
Rules:
- Output only valid YAML, no markdown fences, no extra text
- Use correct GitLab CI syntax: stages:, variables:, before_script:, script:, after_script:, artifacts:, rules:, cache:, needs:
- Define all stages clearly in the top-level stages: list
- Use appropriate GitLab CI features (rules: for conditionals, artifacts: for passing files between stages)
- Preserve environment variables using $VARIABLE_NAME syntax
- Follow GitLab CI best practices`,

  'jenkins': `You are a senior DevOps engineer specializing in Jenkins pipelines.
Generate a complete, production-ready Jenkins Declarative Pipeline (Jenkinsfile) based on the user's description.
Rules:
- Output only valid Groovy Declarative Pipeline syntax, no markdown fences, no extra text
- Use the pipeline { agent { ... } stages { stage('name') { steps { } } } post { } } declarative structure
- Include appropriate post conditions (always, success, failure)
- Preserve environment variables in the environment { } block
- Use agent any unless a specific Docker image or node label is implied
- Follow Jenkins Declarative Pipeline best practices`,
};

const FILE_TYPE_LABELS = { tf: "Terraform", yaml: "YAML", json: "JSON", sh: "Shell Script", arm: "ARM Template", cfn: "CloudFormation" };

function buildSystemPrompt(fileType, explain) {
  const label = FILE_TYPE_LABELS[fileType] || "code";

  if (explain === "explain") {
    return `You are a senior DevOps engineer. Explain the following ${label} code clearly.
- Break it into sections with plain-text headers like "## Variables" or "## Resources"
- Describe what each section does and why
- No markdown code blocks in the explanation`;
  }

  if (explain) {
    return `You are a senior DevOps engineer. Respond with a single valid JSON object and nothing else — no markdown, no code fences, no extra text.

The JSON must have exactly these two keys:
- "code": the generated production-ready ${label} code as a plain string (no markdown code fences)
- "explanation": a clear explanation broken into sections with plain-text headers like "## Variables" or "## Resources"

Follow best practices, add inline comments in the code, and describe what each section does and why in the explanation.`;
  }

  return SYSTEM_PROMPTS[fileType] || `Generate code based on user request. Output only code. No markdown.`;
}

function buildCICDGenerationPrompt(platform) {
  return CICD_GENERATION_PROMPTS[platform] || CICD_GENERATION_PROMPTS['github-actions'];
}

function buildCICDMigrationPrompt(sourcePlatform, targetPlatform) {
  const sourceNames = {
    'github-actions': 'GitHub Actions workflow',
    'azure-devops':   'Azure DevOps Pipeline YAML',
    'gitlab-ci':      'GitLab CI configuration (.gitlab-ci.yml)',
    'jenkins':        'Jenkins Declarative Pipeline (Jenkinsfile)',
    'auto':           'CI/CD pipeline (automatically detect which tool it belongs to)',
  };

  const targetInstructions = {
    'github-actions': `a GitHub Actions workflow YAML file (.github/workflows/pipeline.yml).
- Use on:, jobs:, steps:, uses:, run: syntax
- Use well-known marketplace actions (actions/checkout@v4, actions/setup-node@v4, etc.)
- Map secrets to \${{ secrets.NAME }} syntax`,

    'azure-devops': `an Azure DevOps pipeline YAML (azure-pipelines.yml).
- Use trigger:, pool:, stages:, jobs:, steps:, task: syntax
- Use built-in Azure DevOps tasks (DotNetCoreCLI@2, AzureWebApp@1, Npm@1, etc.) where appropriate
- Map secrets to $(variableName) syntax`,

    'gitlab-ci': `a GitLab CI configuration file (.gitlab-ci.yml).
- Use stages:, variables:, script:, artifacts:, rules:, cache: syntax
- Define all stages in the top-level stages: list
- Map secrets to $VARIABLE_NAME syntax`,

    'jenkins': `a Jenkins Declarative Pipeline (Jenkinsfile).
- Use pipeline { agent { ... } stages { stage('name') { steps { } } } post { } } declarative structure
- Include post conditions (always, success, failure)
- Map secrets to environment { VAR = credentials('id') } or withCredentials blocks`,
  };

  const sourceName = sourceNames[sourcePlatform] || sourceNames['auto'];
  const targetInstruction = targetInstructions[targetPlatform] || targetInstructions['github-actions'];

  return `You are a senior DevOps engineer with deep expertise in GitHub Actions, Azure DevOps Pipelines, GitLab CI, and Jenkins.

The user will provide ${sourceName}. Convert it to ${targetInstruction}

Conversion rules:
- Preserve ALL pipeline logic: every stage, step, condition, trigger, environment variable, and artifact
- Map equivalent concepts between platforms (e.g. GitHub "on: push" → Azure DevOps "trigger:", GitLab "rules:", Jenkins "when { branch }")
- Use idiomatic, modern syntax for the target platform
- Output ONLY the converted pipeline code — no markdown fences, no explanation, no preamble`;
}

function buildMigrationPrompt(targetPlatform) {
  return buildCICDMigrationPrompt('azure-devops', targetPlatform);
}

module.exports = { SYSTEM_PROMPTS, buildSystemPrompt, buildCICDGenerationPrompt, buildCICDMigrationPrompt, buildMigrationPrompt };
