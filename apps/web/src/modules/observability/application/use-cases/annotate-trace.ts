import type {
  Annotation,
  AnnotationDraft,
  AnnotationPage,
  EvaluationGateway,
} from '../evaluation-ports';

/**
 * Error analysis, from the console.
 *
 * The order this exists to enforce: read a trace, name what went wrong, and
 * only then write an evaluator. The taxonomy comes back with every read because
 * the counts are the finding — a failure mode seen once is an anecdote, and one
 * in a third of the annotated traces is the next evaluator to write.
 */
export class ReadAnnotations {
  constructor(private readonly evaluations: EvaluationGateway) {}

  async execute(
    accessToken: string,
    projectId: string,
    options: { traceId?: string; limit?: number } = {},
  ): Promise<AnnotationPage> {
    // An unconfigured evaluation service is an empty surface, not an error: the
    // trace itself is still worth reading, and a page that failed to render
    // because nobody can be annotated would be worse than one without a form.
    if (!this.evaluations.available) return { items: [], taxonomy: [] };

    return this.evaluations.listAnnotations(accessToken, projectId, options);
  }
}

export class AnnotateTrace {
  constructor(private readonly evaluations: EvaluationGateway) {}

  async execute(
    accessToken: string,
    projectId: string,
    draft: AnnotationDraft,
  ): Promise<Annotation> {
    return this.evaluations.recordAnnotation(accessToken, projectId, draft);
  }
}
