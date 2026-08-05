import {
  verificationCheckSchema,
  type VerificationCheck,
  type VerificationSeverity,
  type VerifyBaseDir,
} from '@agent-env/shared';

type SeverityOpts = {
  id?: string;
  severity?: VerificationSeverity;
};

function parseCheck(raw: unknown): VerificationCheck {
  return verificationCheckSchema.parse(raw);
}

/**
 * Serializable verification check factories for AgentDefinition / host policy.
 * Runtime callbacks (custom / agent graders) are registered separately at execute time.
 */
export const verify = {
  nonEmpty(opts?: SeverityOpts): VerificationCheck {
    return parseCheck({
      kind: 'nonEmpty',
      id: opts?.id ?? 'nonEmpty',
      severity: opts?.severity ?? 'required',
    });
  },

  contains(opts: {
    text: string;
    caseInsensitive?: boolean;
    id?: string;
    severity?: VerificationSeverity;
  }): VerificationCheck {
    return parseCheck({
      kind: 'contains',
      id: opts.id ?? `contains:${opts.text}`,
      severity: opts.severity ?? 'required',
      text: opts.text,
      caseInsensitive: opts.caseInsensitive ?? true,
    });
  },

  artifact(opts: {
    artifactId: string;
    mediaTypes: string[];
    minBytes?: number;
    required?: boolean;
    id?: string;
    severity?: VerificationSeverity;
  }): VerificationCheck {
    return parseCheck({
      kind: 'artifact',
      id: opts.id ?? `artifact:${opts.artifactId}`,
      severity: opts.severity ?? 'required',
      artifactId: opts.artifactId,
      mediaTypes: opts.mediaTypes,
      minBytes: opts.minBytes ?? 1,
      required: opts.required ?? true,
    });
  },

  document(opts: {
    sections: string[];
    artifactId?: string;
    sourcePath?: string;
    baseDir?: VerifyBaseDir;
    minLevel?: number;
    maxLevel?: number;
    id?: string;
    severity?: VerificationSeverity;
  }): VerificationCheck {
    return parseCheck({
      kind: 'document',
      id:
        opts.id ??
        `document:${opts.artifactId ?? opts.sourcePath ?? 'finalText'}`,
      severity: opts.severity ?? 'required',
      sections: opts.sections,
      ...(opts.artifactId ? { artifactId: opts.artifactId } : {}),
      ...(opts.sourcePath ? { sourcePath: opts.sourcePath } : {}),
      baseDir: opts.baseDir ?? 'workspace',
      minLevel: opts.minLevel ?? 1,
      maxLevel: opts.maxLevel ?? 3,
    });
  },

  jsonSchema(opts: {
    schemaRef: string;
    sourcePath?: string;
    baseDir?: VerifyBaseDir;
    id?: string;
    severity?: VerificationSeverity;
  }): VerificationCheck {
    return parseCheck({
      kind: 'jsonSchema',
      id: opts.id ?? `jsonSchema:${opts.schemaRef}`,
      severity: opts.severity ?? 'required',
      schemaRef: opts.schemaRef,
      ...(opts.sourcePath ? { sourcePath: opts.sourcePath } : {}),
      baseDir: opts.baseDir ?? 'workspace',
    });
  },

  command(opts: {
    bin: string;
    args?: string[];
    baseDir?: VerifyBaseDir;
    subdir?: string;
    expectExitCode?: number;
    outputContains?: string;
    timeoutMs?: number;
    shell?: boolean;
    id?: string;
    severity?: VerificationSeverity;
  }): VerificationCheck {
    return parseCheck({
      kind: 'command',
      id:
        opts.id ??
        `command:${opts.bin}${opts.args?.length ? ` ${opts.args.join(' ')}` : ''}`,
      severity: opts.severity ?? 'required',
      bin: opts.bin,
      args: opts.args ?? [],
      baseDir: opts.baseDir ?? 'workspace',
      ...(opts.subdir ? { subdir: opts.subdir } : {}),
      expectExitCode: opts.expectExitCode ?? 0,
      ...(opts.outputContains ? { outputContains: opts.outputContains } : {}),
      timeoutMs: opts.timeoutMs ?? 120_000,
      shell: opts.shell ?? false,
    });
  },

  custom(opts: {
    id: string;
    verifierId: string;
    severity?: VerificationSeverity;
  }): VerificationCheck {
    return parseCheck({
      kind: 'custom',
      id: opts.id,
      severity: opts.severity ?? 'required',
      verifierId: opts.verifierId,
    });
  },

  agent(opts: {
    id: string;
    graderId: string;
    severity?: VerificationSeverity;
  }): VerificationCheck {
    return parseCheck({
      kind: 'agent',
      id: opts.id,
      severity: opts.severity ?? 'required',
      graderId: opts.graderId,
    });
  },
} as const;
