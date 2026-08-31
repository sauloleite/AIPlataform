"""The agent definition, as the runtime sees it.

A value object, not a DTO: it arrives from `aia-registry` already frozen at one
published version, and the runtime never edits it. Whatever the registry adds to
the schema later, only what is read here matters to a run.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from aia_errors import ValidationError

#: A run that never stops answering itself would burn the project's budget in
#: silence. Reference doc 02 caps the loop; the value is a ceiling, not a target.
DEFAULT_MAX_STEPS = 12

#: The argument `file_search` needs and the model must not be free to invent.
STORE_ARGUMENT = "store_id"


@dataclass(frozen=True, slots=True)
class AgentDefinition:
    instructions: str
    model_alias: str
    tool_asset_ids: tuple[str, ...] = ()
    store_ids: tuple[str, ...] = ()
    temperature: float | None = None
    top_p: float | None = None
    max_output_tokens: int | None = None

    def __post_init__(self) -> None:
        # Refused at construction, not at the controller: an agent with no model
        # to call is not a valid agent in any layer.
        if not self.instructions.strip():
            raise ValidationError("an agent needs instructions")
        if not self.model_alias.strip():
            raise ValidationError("an agent needs a model alias")

    @property
    def uses_knowledge(self) -> bool:
        return len(self.store_ids) > 0

    @classmethod
    def from_definition(cls, definition: dict[str, Any]) -> AgentDefinition:
        """Reads the registry's `AgentDefinition` payload.

        `tools` names registry assets and `knowledge` names stores owned by
        aia-knowledge; neither is resolved here, because deciding what a caller
        may actually run belongs to aia-mcp-gateway, not to a value object.
        """
        if definition.get("kind") != "agent":
            raise ValidationError(
                "the published version is not an agent", kind=str(definition.get("kind"))
            )

        return cls(
            instructions=str(definition.get("instructions") or ""),
            model_alias=str(definition.get("model_alias") or ""),
            tool_asset_ids=tuple(
                str(ref["asset_id"])
                for ref in definition.get("tools") or []
                if isinstance(ref, dict) and ref.get("asset_id")
            ),
            store_ids=tuple(
                str(ref["store_id"])
                for ref in definition.get("knowledge") or []
                if isinstance(ref, dict) and ref.get("store_id")
            ),
            temperature=_optional_float(definition.get("temperature")),
            top_p=_optional_float(definition.get("top_p")),
            max_output_tokens=_optional_int(definition.get("max_output_tokens")),
        )


@dataclass(frozen=True, slots=True)
class ResolvedAgent:
    """A definition pinned to the version the run will execute end to end."""

    agent_id: str
    version: int
    definition: AgentDefinition
    #: The registry payload as it arrived, kept so the checkpoint can pin it and
    #: a resume executes what the run started with.
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class AvailableTool:
    """A tool the caller may actually run, as aia-mcp-gateway reports it.

    `requires_approval` already combines the tool's risk with the project's
    binding: the runtime does not re-derive it, because the gateway is the one
    that enforces it.
    """

    tool_id: str
    #: The machine name. It is what the model is told to call, so it must
    #: survive a round trip through a provider intact -- unlike `name`, which
    #: is a human label and may hold spaces.
    slug: str
    name: str
    description: str = ""
    risk_level: str = "low"
    requires_approval: bool = False
    parameters: dict[str, Any] = field(default_factory=dict)
    #: Which built-in this is, when the platform runs it rather than an
    #: endpoint. `file_search` needs a store the AGENT supplies, not one the
    #: model names.
    builtin_id: str | None = None

    @property
    def is_file_search(self) -> bool:
        return self.builtin_id == "file_search"


def _optional_float(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _optional_int(value: object) -> int | None:
    return int(value) if isinstance(value, int) and not isinstance(value, bool) else None
