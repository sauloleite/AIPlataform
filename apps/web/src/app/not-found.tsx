import type { ReactElement } from 'react';

export default function NotFound(): ReactElement {
  return (
    <>
      <h1>Not found</h1>
      <p className="lede">
        That page does not exist. <a href="/">Back to the projects</a>.
      </p>
    </>
  );
}
