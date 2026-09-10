"""The client for the platform's canonical API.

Two implementations of one Protocol: `AiaClient` over HTTP, and `FakeAia` in
memory. A consumer's tests take the fake and need no credential, no container
and no network -- which is the question this package's design has to answer, not
a convenience it happens to offer.
"""

from aia_sdk._client import AiaClient
from aia_sdk._errors import PlatformError
from aia_sdk._fake import Document, FakeAia
from aia_sdk._types import (
    Aia,
    ChatEvent,
    Completion,
    Delta,
    Finished,
    Message,
    ModelAlias,
    Routing,
    Run,
    SearchHit,
    StreamError,
    TokenSource,
    ToolCall,
    Usage,
)

__all__ = [
    "Aia",
    "AiaClient",
    "ChatEvent",
    "Completion",
    "Delta",
    "Document",
    "FakeAia",
    "Finished",
    "Message",
    "ModelAlias",
    "PlatformError",
    "Routing",
    "Run",
    "SearchHit",
    "StreamError",
    "TokenSource",
    "ToolCall",
    "Usage",
]
