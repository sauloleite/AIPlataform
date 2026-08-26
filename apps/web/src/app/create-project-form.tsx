'use client';

import type { ReactElement } from 'react';
import { useActionState } from 'react';

import { createProjectAction, type ActionResult } from './actions';
import { CLASSIFICATIONS, zonesFor } from '../modules/console/domain/classification';

const EMPTY: ActionResult = {};

export function CreateProjectForm(): ReactElement {
  const [state, action, pending] = useActionState(createProjectAction, EMPTY);

  return (
    <form action={action}>
      {state.error !== undefined && (
        <p className="notice error" role="alert">
          {state.error}
        </p>
      )}

      <div className="row">
        <label className="field">
          <span>Name</span>
          <input name="name" required minLength={3} maxLength={120} />
        </label>
        <label className="field">
          <span>Slug</span>
          <input name="slug" required pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]" />
        </label>
      </div>

      <label className="field">
        <span>Description</span>
        <input name="description" maxLength={1000} />
      </label>

      <label className="field">
        <span>Data classification</span>
        <select name="dataClassification" defaultValue="internal">
          {CLASSIFICATIONS.map((classification) => (
            <option key={classification} value={classification}>
              {classification} — reaches {zonesFor(classification).join(', ')}
            </option>
          ))}
        </select>
      </label>

      {/* Required by LGPD art. 7. Governance refuses without them, so the form
          asks for them rather than letting the user discover it through a 400. */}
      <div className="row">
        <label className="field">
          <span>Legal basis</span>
          <input name="legalBasis" required placeholder="legitimate interest" />
        </label>
        <label className="field">
          <span>Purpose</span>
          <input name="purpose" required placeholder="internal support assistant" />
        </label>
      </div>

      <button type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Create project'}
      </button>
    </form>
  );
}
