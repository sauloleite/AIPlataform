/** Commands and results. No `Request`, no headers, no HTTP decorators. */

export interface ExampleCommand {
  projectId: string;
}

export interface ExampleResult {
  id: string;
}
