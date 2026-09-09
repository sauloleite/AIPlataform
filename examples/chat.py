#!/usr/bin/env python3
"""The Python SDK against a local platform.

No API key: `chat-local` runs on the machine. That is the promise this file
exists to check.
"""

from __future__ import annotations

import asyncio
import os
import sys

import httpx

from aia_sdk import AiaClient, Delta, Message, PlatformError, StreamError

BASE_URL = os.environ.get("PLATFORM_BASE_URL", "http://localhost:8080")
EMAIL = os.environ.get("IDENTITY_BOOTSTRAP_ADMIN_EMAIL", "admin@aia.local")
PASSWORD = os.environ.get("IDENTITY_BOOTSTRAP_ADMIN_PASSWORD", "change-me-now")
PROJECT_SLUG = os.environ.get("AIA_PROJECT_SLUG", "sample")


async def sign_in(client: httpx.AsyncClient) -> str:
    """Not the SDK's job, and that is a decision rather than a gap.

    How a program obtains a token is its own business -- a password here, a
    personal access token in a script, client credentials in a service. What
    the SDK takes is the token, or a function that produces one.
    """
    response = await client.post(
        f"{BASE_URL}/v1/auth/token",
        json={"grant_type": "password", "username": EMAIL, "password": PASSWORD},
    )
    if response.status_code != httpx.codes.OK:
        raise SystemExit(
            f"Could not sign in ({response.status_code}). Is the platform up? Try: make dev"
        )
    token: str = response.json()["access_token"]
    return token


async def project_id(client: httpx.AsyncClient, token: str) -> str:
    response = await client.get(
        f"{BASE_URL}/v1/projects", headers={"Authorization": f"Bearer {token}"}
    )
    for project in response.json()["items"]:
        if project["slug"] == PROJECT_SLUG:
            found: str = project["id"]
            return found
    raise SystemExit(f'No project "{PROJECT_SLUG}". Run: make seed')


async def main() -> None:
    async with httpx.AsyncClient(timeout=30) as http:
        token = await sign_in(http)
        project = await project_id(http, token)

    async with AiaClient(base_url=BASE_URL, project_id=project, token=token) as aia:
        print("Aliases this project may use:")
        for alias in await aia.models():
            print(f"  {alias.id:<16} zones: {', '.join(alias.data_zones)}")

        try:
            answer = await aia.chat(
                model="chat-local",
                messages=[
                    Message(role="user", content="Answer in one word: is this platform running?")
                ],
                max_tokens=16,
            )
            print(f"\n{answer.content}")
            # The routing metadata is the point of a governed gateway: which
            # deployment served it, in which zone, at what cost.
            print(
                f"  served by {answer.routing.provider} in zone {answer.routing.data_zone}, "
                f"{answer.routing.cost_micros} micros, {answer.usage.total_tokens} tokens"
            )

            print("\nstreaming: ", end="", flush=True)
            async for event in aia.chat_stream(
                model="chat-local",
                messages=[Message(role="user", content="Count to three.")],
                max_tokens=32,
            ):
                if isinstance(event, Delta):
                    print(event.content, end="", flush=True)
                elif isinstance(event, StreamError):
                    print(f"\n  the stream failed: {event.code}", end="")
            print()
        except PlatformError as error:
            # The stable code is what a caller branches on, and the trace id is
            # what makes a bug report findable.
            print(f"\nRefused: {error.code} ({error.status}) -- {error}", file=sys.stderr)
            if error.trace_id is not None:
                print(f"  trace: {error.trace_id}", file=sys.stderr)
            raise SystemExit(1) from error


if __name__ == "__main__":
    asyncio.run(main())
