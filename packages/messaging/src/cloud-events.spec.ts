import { describe, expect, it } from 'vitest';
import { ValidationError } from '@aia/errors';
import { EVENT_TYPES, newEvent } from './cloud-events.js';

describe('newEvent', () => {
  it('monta o envelope CloudEvents com o projeto no subject', () => {
    const event = newEvent({
      type: EVENT_TYPES.USAGE_RECORDED,
      source: '/aia/inference-router',
      projectId: 'proj-1',
      data: { totalTokens: 120 },
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      id: 'evt-1',
      time: new Date('2026-01-15T10:00:00Z'),
    });

    expect(event).toEqual({
      specversion: '1.0',
      type: 'aia.inference.usage.recorded.v1',
      source: '/aia/inference-router',
      id: 'evt-1',
      time: '2026-01-15T10:00:00.000Z',
      subject: 'proj-1',
      datacontenttype: 'application/json',
      data: { totalTokens: 120 },
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });
  });

  it('exige o projeto: sem tenant o evento nao pode ser roteado nem filtrado', () => {
    expect(() =>
      newEvent({ type: EVENT_TYPES.USAGE_RECORDED, source: '/x', projectId: '', data: {} }),
    ).toThrow(ValidationError);
  });

  it.each([
    'usage.recorded.v1',
    'aia.inference.usage.recorded',
    'aia.Inference.Usage.v1',
    'aia.inference.v',
  ])('recusa o type mal formado %p', (type) => {
    expect(() => newEvent({ type, source: '/x', projectId: 'proj-1', data: {} })).toThrow(
      ValidationError,
    );
  });

  it('todos os tipos do catalogo passam na propria validacao', () => {
    for (const type of Object.values(EVENT_TYPES)) {
      expect(() => newEvent({ type, source: '/x', projectId: 'proj-1', data: {} })).not.toThrow();
    }
  });

  it('gera id e time quando nao informados', () => {
    const event = newEvent({
      type: EVENT_TYPES.PROJECT_CREATED,
      source: '/x',
      projectId: 'proj-1',
      data: {},
    });
    expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(event.time)).not.toBeNaN();
  });
});
