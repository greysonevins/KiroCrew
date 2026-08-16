"""Slack Enterprise Grid workspace validation (default-open).

Optionally restricts the bot to specific Enterprise Grid workspaces when
an operator configures ``slack.allowed_enterprise_ids``.  With no
allowlist configured (the default), all workspaces are accepted — this
is an opt-in restriction, not a hardcoded one.

Two layers of defence:
1. ``validate_enterprise()`` at gateway startup — calls ``auth.test``,
   caches the validated ``team_id``, and (when an allowlist is
   configured) blocks workspaces outside the allowlist.
2. ``check_message_origin()`` on every incoming message — compares the
   event's ``team`` field against the cached value (zero-cost in-memory
   check, no API call).  Catches hot-swap of ``.env`` tokens while the
   gateway is running.  Allows everything when no allowlist is set.
"""

from __future__ import annotations

import logging

from kiro_crew.config.loader import (
    ConfigReadError,
    KiroCrewConfig,
    config_local_path,
    config_path,
    read_config_for_update,
)
from kiro_crew.sel import sel

logger = logging.getLogger(__name__)

# Cached at startup by validate_enterprise().  Checked per-message by
# check_message_origin().  Module-level — safe because the gateway runs
# in a single asyncio event loop.
_validated_team_id: str = ""
_validated_enterprise_id: str = ""

# Set of team_ids accepted by check_message_origin().  Contains the
# validated team_id plus any workspace IDs explicitly listed in
# ``slack.allowed_enterprise_ids`` config — populated once during
# validate_enterprise() so per-message checks remain pure in-memory
# lookups.  See ``_load_allowed_team_ids``.
_allowed_team_ids: set[str] = set()

# True when the operator configured a non-empty
# ``slack.allowed_enterprise_ids`` allowlist.  When False (the default),
# both validate_enterprise() and check_message_origin() are default-open.
_allowlist_configured: bool = False


def _config_load_degraded() -> bool:
    """Return True when a config file exists on disk but ``load()`` degraded it.

    ``KiroCrewConfig.load()`` swallows a torn or corrupt ``config.json`` (or its
    ``config.local.json`` overlay), logs a warning, and returns a *defaults*
    object rather than raising.  A defaults object carries an empty
    ``slack.allowed_enterprise_ids``, which is indistinguishable from an operator
    who configured no allowlist.

    This helper positively detects that degraded case so the caller can fail
    CLOSED instead of silently reopening the allowlist.  It delegates to
    :func:`read_config_for_update`, which owns the "can this file be read as a
    JSON object" question: an absent file returns ``{}`` (genuinely
    unconfigured, so the allowlist stays default-open as designed), while an
    unreadable file *or one holding valid non-object JSON* raises
    ``ConfigReadError``.  That second case matters: ``[]`` parses cleanly yet
    ``load()`` still discards it for defaults, so a hand-rolled ``json.loads``
    probe would call it healthy and reopen the allowlist.  Reusing the shared
    contract keeps this invariant in one home -- the same shape the publish
    guards use.
    """
    for path in (config_path(), config_local_path()):
        try:
            read_config_for_update(path)
        except ConfigReadError as e:
            logger.warning("slack enterprise allowlist: %s", e)
            return True
    return False


def _load_allowed_team_ids() -> None:
    """Populate ``_allowed_team_ids`` from validated state + config.

    Called by ``validate_enterprise()`` after the validated team_id has
    been cached.  The result includes:
      - the validated team_id (from ``auth.test``)
      - every entry in ``slack.allowed_enterprise_ids`` config

    On Enterprise Grid, ``auth.test`` returns the org-level enterprise ID
    while per-message events carry child workspace team_ids.  Operators
    add child workspace IDs to ``slack.allowed_enterprise_ids`` to allow
    those events through ``check_message_origin``.

    Sets ``_allowlist_configured`` based on whether the operator supplied
    any ``slack.allowed_enterprise_ids`` entries.  When none are
    configured the module stays default-open.

    Fail-closed on a degraded read: ``KiroCrewConfig.load()`` degrades a
    corrupt ``config.json`` (or a torn ``config.local.json`` overlay) to
    defaults instead of raising.  The invariant this function holds is that
    **degradation is decided before any value derived from the load is
    trusted**: a degraded read can still return a non-empty allowlist (a
    corrupt overlay leaves the base file's entries in place), so testing
    "did the operator configure entries?" first would apply a list the
    operator did not ask for.  When degradation is detected -- the load
    raised, or a config file exists that ``read_config_for_update`` refuses
    -- the module keeps ``_allowlist_configured`` True with only the
    validated team_id admitted and SEL-audits it, rather than silently
    widening the allowlist.
    """
    global _allowed_team_ids, _allowlist_configured
    allowed: set[str] = set()
    if _validated_team_id:
        allowed.add(_validated_team_id)

    configured: set[str] = set()
    load_failed = False
    try:
        cfg = KiroCrewConfig.load()
        configured = set(cfg.slack.allowed_enterprise_ids)
    except Exception:
        load_failed = True
        logger.exception(
            "Failed to load slack.allowed_enterprise_ids; failing closed "
            "with validated team_id only"
        )

    if load_failed or _config_load_degraded():
        # We could NOT read the operator's configuration: load() raised, or a
        # config file exists on disk that read_config_for_update refuses.
        #
        # This gate runs FIRST, before any value derived from the load is
        # trusted, because a degraded read can still yield a NON-EMPTY
        # ``configured``: load() merges config.local.json over config.json and
        # swallows a torn overlay, so a corrupt overlay returns the BASE file's
        # entries. Trusting those would silently apply an allowlist the operator
        # did not ask for -- the same "a corrupt config widens the origin
        # allowlist" failure this whole path exists to prevent, just arriving
        # through the overlay instead of the base.
        #
        # An empty allowlist here is also indistinguishable from "operator
        # configured none", so fail CLOSED either way: keep the allowlist
        # "configured" with only the validated team_id admitted so
        # check_message_origin() denies foreign origins, and SEL-audit it. We
        # cannot know the intended list, so the authenticated workspace is the
        # only thing we can honestly admit.
        _allowlist_configured = True
        logger.error(
            "slack.allowed_enterprise_ids could not be read (corrupt config); "
            "failing closed with validated team_id only"
        )
        sel().log_api_access(
            caller="gateway",
            operation="slack.allowed_team_ids_load",
            outcome="denied",
            source="startup",
            error="config_load_degraded_fail_closed",
        )
    elif configured:
        # Every config file read cleanly and the operator configured an
        # allowlist.
        _allowlist_configured = True
        allowed.update(configured)
    else:
        # Genuinely unconfigured: no config file, or a clean file with no
        # allowlist entries.  Stay default-open exactly as before.
        _allowlist_configured = False

    _allowed_team_ids = allowed


def _governance_posture_permits_workspace(enterprise_id: str, team_id: str) -> bool:
    """Check the workspace against ``channels.posture.slack.allowed_enterprise_ids``.

    The governance ``channels`` ScopedMap may carry a policy-only ``posture`` for
    the ``slack`` member pinning ``allowed_enterprise_ids`` (and/or
    ``allowed_team_ids``) — an enterprise ceiling the agent cannot edit. We query
    it via ``governance_permits("channels", "slack/<leaf>:<value>")`` for each
    candidate id. Default-open (True) when no policy / no posture governs it, so a
    standalone host is unaffected. Fail-closed (deny) on ANY error — a
    PlatformCompositionError (a host that could not compose its companion) OR any
    other unexpected error → deny; a governance error must not
    silently permit a workspace the operator's posture would restrict.
    """
    from kiro_crew.platform.context import PlatformCompositionError

    try:
        from kiro_crew.platform.governance_profiles import governance_permits

        # An empty session key resolves policy-only — exactly the ceiling we want:
        # the posture is policy-only (Rule 6 rejects a profile carrying it), so a
        # surface-bound profile must NOT additionally intersect here.  (The degrade
        # audit below uses the _host surface only for honest SEL attribution.)
        for leaf, value in (("allowed_enterprise_ids", enterprise_id), ("allowed_team_ids", team_id)):
            if not value:
                # An EMPTY id (Slack returns enterprise_id="" for every
                # non-Enterprise-Grid workspace, the common case) cannot satisfy
                # an explicitly-pinned allowlist, so it must fail CLOSED when the
                # leaf is pinned — otherwise an operator's un-weakenable
                # allowed_enterprise_ids ceiling is silently bypassed.  Probe the
                # posture with a sentinel that no real id can equal: if the leaf
                # is an allow-mode allowlist the sentinel is DENIED (pinned →
                # close); if the leaf is ungoverned / deny-mode / allow-any the
                # sentinel PERMITS (not pinned → the empty id is fine, skip).
                probe = governance_permits("channels", f"slack/{leaf}:\x00__unpinned_probe__")
                if not getattr(probe, "permitted", True):
                    return False
                continue
            decision = governance_permits("channels", f"slack/{leaf}:{value}")
            if not getattr(decision, "permitted", True):
                return False
        return True
    except PlatformCompositionError:
        raise
    except Exception:
        # Fail CLOSED: a governance evaluation error must DENY the
        # workspace, not silently permit it.  session
        # key=_host so the degrade SEL records the honest "host" surface (this
        # in-process admission check is not driven by a Slack session).
        try:
            from kiro_crew.platform.governance_profiles import (
                HOST_SESSION_KEY,
                audit_governance_degraded,
            )

            audit_governance_degraded(
                "slack_enterprise_posture",
                session_key=HOST_SESSION_KEY,
                scope="channels.posture",
                failed_closed=True,
            )
        except Exception:
            logger.debug("governance degrade audit unavailable", exc_info=True)
        return False


def validate_enterprise(
    bot_token: str,
    *,
    extra_ids: set[str] | None = None,
) -> bool:
    """Validate the configured workspace (default-open).

    Calls ``auth.test`` to cache ``team_id`` and ``enterprise_id`` so
    ``check_message_origin()`` can verify each incoming message without
    an API call.

    Default-open: returns True for any workspace unless the operator
    configured an allowlist via ``slack.allowed_enterprise_ids`` (or
    passed ``extra_ids``), in which case the workspace's enterprise_id
    must appear in that allowlist.  Logs the result to SEL for audit.
    """
    global _validated_team_id, _validated_enterprise_id, _allowed_team_ids
    global _allowlist_configured

    # Clear stale state before re-validating.
    _validated_team_id = ""
    _validated_enterprise_id = ""
    _allowed_team_ids = set()
    _allowlist_configured = False

    extra = extra_ids or set()

    try:
        from slack_sdk.web import WebClient

        client = WebClient(token=bot_token)
        resp = client.auth_test()
    except Exception:
        # auth.test failed (missing slack_sdk or API error): the workspace
        # identity cannot be verified.  Whether we fail open or closed
        # depends on whether an allowlist is configured.
        #
        # An allowlist is configured if extra_ids was passed OR the
        # operator set slack.allowed_enterprise_ids in config.  Reading
        # config here cannot rely on auth.test having succeeded, so check
        # it directly.
        configured: set[str] = set()
        try:
            cfg = KiroCrewConfig.load()
            configured = set(cfg.slack.allowed_enterprise_ids)
        except Exception:
            logger.exception(
                "Failed to load slack.allowed_enterprise_ids during "
                "auth.test failure handling"
            )
        allowlist = extra | configured

        if allowlist:
            # FAIL CLOSED: an operator restriction is in force but the
            # workspace identity could not be verified.  Accepting an
            # unverifiable workspace against an explicit allowlist would
            # silently bypass the restriction.  check_message_origin()
            # also denies because no validated team_id was cached.
            _allowlist_configured = True
            _allowed_team_ids = set(allowlist)
            logger.error(
                "Enterprise validation FAILED: auth.test unavailable and an "
                "allowlist is configured; cannot verify workspace identity."
            )
            sel().log_api_access(
                caller="gateway",
                operation="slack.enterprise_validation",
                outcome="denied",
                source="startup",
                error="auth_test_unavailable_with_allowlist",
            )
            return False

        # Default-open: no allowlist configured, so a missing slack_sdk or
        # auth.test failure must not block startup.  Without cached state,
        # check_message_origin() stays default-open too.
        logger.warning(
            "Enterprise validation: auth.test unavailable; "
            "continuing default-open"
        )
        sel().log_api_access(
            caller="gateway",
            operation="slack.enterprise_validation",
            outcome="allowed",
            source="startup",
            error="auth_test_unavailable",
        )
        return True

    enterprise_id = resp.get("enterprise_id", "")
    team_id = resp.get("team_id", "")
    team = resp.get("team", "")
    url = resp.get("url", "")

    # Cache for per-message checks (populates _allowlist_configured from
    # slack.allowed_enterprise_ids config).
    _validated_team_id = team_id
    _validated_enterprise_id = enterprise_id
    _load_allowed_team_ids()
    if extra:
        _allowlist_configured = True
        _allowed_team_ids.update(extra)

    # Default-open unless the operator configured an allowlist.
    if _allowlist_configured:
        candidate = enterprise_id or team_id
        if candidate not in _allowed_team_ids:
            logger.error(
                "Enterprise validation FAILED: enterprise_id=%s (team=%s) "
                "is not in slack.allowed_enterprise_ids.",
                enterprise_id,
                team,
            )
            sel().log_api_access(
                caller="gateway",
                operation="slack.enterprise_validation",
                outcome="denied",
                source="startup",
                resources=f"enterprise_id={enterprise_id} team={team} url={url}",
                error="enterprise_id_not_allowed",
            )
            return False

    # Governance posture (un-weakenable): the enterprise security policy may pin
    # ``channels.posture.slack.allowed_enterprise_ids`` — an enterprise ceiling the
    # AGENT cannot edit (config.json's slack.allowed_enterprise_ids is operator-
    # editable; the posture is the policy-level, agent-unweakenable equivalent).
    # This composes as an ADDITIONAL ceiling: the workspace must satisfy the
    # governance posture too. Default-open when no posture is configured.
    if not _governance_posture_permits_workspace(enterprise_id, team_id):
        logger.error(
            "Enterprise validation FAILED: enterprise_id=%s (team=%s) is not "
            "permitted by the governance channels.posture allowlist.",
            enterprise_id,
            team,
        )
        sel().log_api_access(
            caller="gateway",
            operation="slack.enterprise_validation",
            outcome="denied",
            source="startup",
            resources=f"enterprise_id={enterprise_id} team={team} url={url}",
            error="enterprise_id_not_allowed_by_governance",
        )
        return False

    logger.info(
        "Enterprise validation OK: enterprise_id=%s team=%s team_id=%s",
        enterprise_id,
        team,
        team_id,
    )
    sel().log_api_access(
        caller="gateway",
        operation="slack.enterprise_validation",
        outcome="allowed",
        source="startup",
        resources=f"enterprise_id={enterprise_id} team={team} team_id={team_id}",
    )
    return True


def check_message_origin(event_team_id: str) -> bool:
    """Verify an incoming message's team_id is allowed (default-open).

    Zero-cost in-memory comparison — no API call, no config load.  The
    allowed set is populated once during ``validate_enterprise()``;
    re-validate to refresh.

    Default-open: returns True for any message unless the operator
    configured an allowlist via ``slack.allowed_enterprise_ids``, in
    which case the event's team_id must appear in that allowlist.

    Every permission decision (accept, deny) is audited via SEL per the
    ``security-controls`` guideline.

    Enterprise Grid: ``auth.test`` returns the org-level enterprise ID
    as ``team_id`` while per-message events carry child workspace
    team_ids.  Operators add child workspace IDs to
    ``slack.allowed_enterprise_ids`` config so legitimate events from
    those workspaces are accepted via the same allowed-set lookup.
    """
    if not _allowlist_configured:
        # No operator allowlist — accept all message origins.
        sel().log_api_access(
            caller="gateway",
            operation="slack.message_origin_check",
            outcome="allowed",
            source="message",
            resources=f"team_id={event_team_id}",
            error="no_allowlist_configured",
        )
        return True
    if not event_team_id:
        sel().log_api_access(
            caller="gateway",
            operation="slack.message_origin_check",
            outcome="denied",
            source="message",
            error="empty_team_id",
        )
        return False
    if event_team_id in _allowed_team_ids:
        sel().log_api_access(
            caller="gateway",
            operation="slack.message_origin_check",
            outcome="allowed",
            source="message",
            resources=f"team_id={event_team_id}",
        )
        return True
    sel().log_api_access(
        caller="gateway",
        operation="slack.message_origin_check",
        outcome="denied",
        source="message",
        resources=f"team_id={event_team_id}",
        error="not_in_allowlist",
    )
    return False
