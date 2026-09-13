#!/usr/bin/env python3
"""Browser acceptance test for an already-running isolated ZTQ server."""

import argparse
import json
import os
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--api-token")
    parser.add_argument("--api-token-file")
    parser.add_argument("--desktop-shot", required=True)
    parser.add_argument("--mobile-shot", required=True)
    args = parser.parse_args()
    parsed_url = urlsplit(args.base_url)
    fragment_token = parse_qs(parsed_url.fragment).get("token", [None])[0]
    file_token = Path(args.api_token_file).read_text(encoding="utf-8").strip() if args.api_token_file else None
    api_token = args.api_token or file_token or fragment_token or os.environ.get("ZTQ_API_TOKEN")
    if not api_token:
        raise SystemExit("an API token is required via --api-token, ZTQ_API_TOKEN, or #token= in --base-url")
    origin = f"{parsed_url.scheme}://{parsed_url.netloc}"
    page_url = urlunsplit((
        parsed_url.scheme,
        parsed_url.netloc,
        parsed_url.path or "/",
        parsed_url.query,
        urlencode({"token": api_token}),
    ))
    auth_headers = {"Authorization": f"Bearer {api_token}"}
    run_key = uuid4().hex
    desktop_shot = Path(args.desktop_shot)
    mobile_shot = Path(args.mobile_shot)
    desktop_shot.parent.mkdir(parents=True, exist_ok=True)
    mobile_shot.parent.mkdir(parents=True, exist_ok=True)
    report = {}

    with sync_playwright() as playwright:
        executable = os.environ.get("ZTQ_PLAYWRIGHT_EXECUTABLE")
        if executable:
            browser = playwright.chromium.launch(headless=True, executable_path=executable)
        else:
            try:
                browser = playwright.chromium.launch(headless=True)
            except Exception as original_error:
                candidates = [
                    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                ]
                fallback = next((item for item in candidates if Path(item).is_file()), None)
                if not fallback:
                    raise original_error
                browser = playwright.chromium.launch(headless=True, executable_path=fallback)
        context = browser.new_context(viewport={"width": 1440, "height": 1000})
        page = context.new_page()
        console_errors = []
        page_errors = []
        failed_requests = []
        http_errors = []
        phase = {"name": "initial-load"}
        observed_api = {"state_authorization": None, "event_token": None}

        def observe_request(request) -> None:
            parsed_request = urlsplit(request.url)
            if parsed_request.path == "/api/state":
                observed_api["state_authorization"] = request.headers.get("authorization")
            elif parsed_request.path == "/api/events":
                observed_api["event_token"] = parse_qs(parsed_request.query).get("token", [None])[0]

        page.on("request", observe_request)
        def record_failed_request(request) -> None:
            parsed_request = urlsplit(request.url)
            failed_requests.append({
                "method": request.method,
                "origin": f"{parsed_request.scheme}://{parsed_request.netloc}",
                "path": parsed_request.path,
                "failure": request.failure,
            })

        page.on("requestfailed", record_failed_request)
        page.on("response", lambda response: http_errors.append({
            "status": response.status,
            "url": urlunsplit((*urlsplit(response.url)[:3], "", "")),
            "resourceType": response.request.resource_type,
            "phase": phase["name"],
        }) if response.status >= 400 else None)
        page.on("console", lambda message: console_errors.append(message.text.replace(api_token, "[REDACTED]")) if message.type == "error" else None)
        page.on("pageerror", lambda error: page_errors.append(str(error).replace(api_token, "[REDACTED]")))
        page.goto(page_url, wait_until="domcontentloaded")
        expect(page.get_by_test_id("app-root")).to_have_attribute("data-connection", "online", timeout=8000)
        expect(page.get_by_test_id("connection-status")).to_have_text("本机服务在线")
        assert "#token=" not in page.url
        assert page.evaluate("sessionStorage.getItem('zcode-task-queue.api-token')") == api_token
        assert page.evaluate("localStorage.getItem('zcode-task-queue.api-token')") is None
        for _ in range(40):
            if observed_api["state_authorization"] and observed_api["event_token"]:
                break
            page.wait_for_timeout(50)
        assert observed_api["state_authorization"] == f"Bearer {api_token}"
        assert observed_api["event_token"] == api_token
        assert page.locator("script:not([src])").count() == 0
        assert page.locator("[onclick], [onload], [onerror]").count() == 0
        counts = page.evaluate("state.counts")
        assert all(counts.get(key, 0) == 0 for key in ("active", "pending", "history", "trash")), counts

        # A storage-fatal state is genuinely read-only in the controls, not
        # merely described by a banner.
        page.evaluate("state.storage.healthy = false; syncMutationControls()")
        expect(page.get_by_test_id("queue-toggle")).to_be_disabled()
        page.evaluate("state.storage.healthy = true; syncMutationControls()")
        expect(page.get_by_test_id("queue-toggle")).to_be_enabled()

        # Native dialog focus, Escape, and opener restoration.
        opener = page.get_by_test_id("new-task-open")
        opener.click()
        expect(page.get_by_test_id("new-task-dialog")).to_be_visible()
        expect(page.locator("#new-task-title")).to_be_focused()
        page.keyboard.press("Escape")
        expect(page.get_by_test_id("new-task-dialog")).to_be_hidden()
        expect(opener).to_be_focused()

        def set_queue_paused(paused: bool) -> None:
            toggle = page.get_by_test_id("queue-toggle")
            expected = "true" if paused else "false"
            if toggle.get_attribute("aria-pressed") != expected:
                toggle.click()
            expect(toggle).to_have_attribute("aria-pressed", expected)

        # Pause, then create two literal-text tasks so none can run during editing.
        set_queue_paused(True)

        def fill_task(name: str, command: str) -> None:
            opener.click()
            page.locator("#task-type").select_option("shell")
            page.locator("#task-name").fill(name)
            page.locator("#task-prompt").fill(command)
            page.get_by_test_id("task-timeout").fill("0")

        def create_task(name: str, command: str) -> None:
            fill_task(name, command)
            page.get_by_test_id("new-task-submit").click()
            expect(page.get_by_test_id("new-task-dialog")).to_be_hidden()
            expect(page.get_by_test_id("pending-list").get_by_text(name, exact=True)).to_be_visible()

        malicious_name = '<img src=x onerror="window.__xss=1">'
        first_command = "sleep 2.2; printf 'ui-one\\n'"
        phase["name"] = "response-loss-idempotency"
        # The first two requests reach the server and commit, but their
        # responses are lost. The retry must reuse the same key and the server
        # must expose only one logical task.
        mutation_keys = []

        def drop_committed_task_responses(route) -> None:
            mutation_keys.append(route.request.headers.get("idempotency-key"))
            response = route.fetch()
            if len(mutation_keys) <= 2:
                route.abort("connectionfailed")
            else:
                route.fulfill(response=response)

        page.route("**/api/tasks", drop_committed_task_responses)
        fill_task(malicious_name, first_command)
        page.get_by_test_id("new-task-submit").click()
        expect(page.get_by_test_id("new-task-error")).to_be_visible(timeout=3000)
        expect(page.get_by_test_id("new-task-dialog")).to_be_visible()
        assert page.request.get(
            f"{origin}/api/state?view=summary", headers=auth_headers,
        ).json()["counts"]["pending"] == 1
        expected_failures = [
            failure for failure in failed_requests
            if failure["origin"] == origin
            and failure["path"] == "/api/tasks"
            and failure["method"] == "POST"
            and failure["failure"] == "net::ERR_CONNECTION_FAILED"
        ]
        assert len(expected_failures) == 2, failed_requests
        assert len(failed_requests) == len(expected_failures), failed_requests
        persisted_uncertain = page.evaluate(
            "JSON.parse(localStorage.getItem('zcode-task-queue.uncertain-operations.v2') || '[]')",
        )
        assert len(persisted_uncertain) == 1
        assert persisted_uncertain[0]["firstSeenAt"] > 0
        serialized_uncertain = json.dumps(persisted_uncertain, ensure_ascii=False)
        assert malicious_name not in serialized_uncertain
        assert first_command not in serialized_uncertain
        reload_failure_start = len(failed_requests)
        phase["name"] = "response-loss-idempotency-reload"
        page.reload(wait_until="domcontentloaded")
        expect(page.get_by_test_id("app-root")).to_have_attribute("data-connection", "online", timeout=8000)
        expect(page.get_by_test_id("queue-toggle")).to_have_attribute("aria-pressed", "true")
        fill_task(malicious_name, first_command)
        page.get_by_test_id("new-task-submit").click()
        expect(page.get_by_test_id("new-task-dialog")).to_be_hidden()
        expect(page.get_by_test_id("pending-list").get_by_text(malicious_name, exact=True)).to_be_visible()
        assert len(mutation_keys) == 3 and len(set(mutation_keys)) == 1, mutation_keys
        assert page.request.get(
            f"{origin}/api/state?view=summary", headers=auth_headers,
        ).json()["counts"]["pending"] == 1
        remaining_tombstones = page.evaluate(
            "localStorage.getItem('zcode-task-queue.uncertain-operations.v2')",
        )
        assert remaining_tombstones is None, remaining_tombstones
        page.unroute("**/api/tasks", drop_committed_task_responses)
        reload_failures = failed_requests[reload_failure_start:]
        reload_sse_aborts = [
            failure for failure in reload_failures
            if failure["origin"] == origin
            and failure["path"] == "/api/events"
            and failure["method"] == "GET"
            and failure["failure"] == "net::ERR_ABORTED"
        ]
        assert len(reload_sse_aborts) <= 1, reload_failures
        assert len(reload_failures) == len(reload_sse_aborts), reload_failures
        # Chromium reports the two deliberately dropped responses as console
        # resource errors. They are expected test stimuli, not product noise.
        console_errors.clear()
        second_name = "UI second task changed"
        phase["name"] = "changed-input-install-wrapper"
        page.evaluate("""
            () => {
              const original = window.fetch.bind(window);
              window.__ztqOriginalFetch = original;
              window.__ztqMutationKeys = [];
              window.__ztqFailuresLeft = 2;
              window.fetch = async (input, options = {}) => {
                const url = typeof input === 'string' ? input : input.url;
                if (url.includes('/api/tasks') && options.method === 'POST') {
                  window.__ztqMutationKeys.push(options.headers['Idempotency-Key']);
                  if (window.__ztqFailuresLeft > 0) {
                    window.__ztqFailuresLeft -= 1;
                    throw new TypeError('simulated unknown network outcome');
                  }
                }
                return original(input, options);
              };
            }
        """)
        phase["name"] = "changed-input-first-fill"
        fill_task("UI second task", "printf 'ui-two\\n'")
        phase["name"] = "changed-input-first-submit"
        page.get_by_test_id("new-task-submit").click()
        expect(page.get_by_test_id("new-task-error")).to_be_visible(timeout=3000)
        phase["name"] = "changed-input-edit"
        page.locator("#task-name").fill(second_name)
        phase["name"] = "changed-input-second-submit"
        page.get_by_test_id("new-task-submit").click()
        expect(page.get_by_test_id("new-task-dialog")).to_be_hidden()
        expect(page.get_by_test_id("pending-list").get_by_text(second_name, exact=True)).to_be_visible()
        changed_keys = page.evaluate("window.__ztqMutationKeys")
        assert len(changed_keys) == 3 and changed_keys[0] == changed_keys[1]
        assert changed_keys[2] != changed_keys[0], changed_keys
        phase["name"] = "changed-input-restore-wrapper"
        page.evaluate("() => { window.fetch = window.__ztqOriginalFetch; }")
        # The first synthetic request was proven not to reach fetch's network
        # implementation. Clear only that fixture tombstone so later probes
        # start from a known storage state.
        page.evaluate("""
            () => {
              const body = {
                type: 'shell', name: 'UI second task', prompt: "printf 'ui-two\\\\n'",
                cwd: '', timeoutMin: 0,
              };
              forgetUncertainOperation('new-task', operationFingerprint('/api/tasks', body));
            }
        """)

        # 5xx and malformed 2xx responses are unknown outcomes and retain the
        # key; a 4xx response is definitive and clears it.
        phase["name"] = "synthetic-response-idempotency"
        idempotency_probe = page.evaluate("""
            async () => {
              const original = window.fetch;
              const run = async (operation, status, payload) => {
                const keys = [];
                window.fetch = async (_input, options = {}) => {
                  keys.push(options.headers['Idempotency-Key']);
                  return new Response(payload, {status, headers: {'Content-Type': 'application/json'}});
                };
                try { await mutate(operation, null, '/api/config', {scheduleStart: '04:56'}); } catch {}
                const fingerprint = operationFingerprint('/api/config', {scheduleStart: '04:56'});
                const retained = uncertainOperations.has(uncertainIdentity(operation, fingerprint));
                forgetUncertainOperation(operation, fingerprint);
                return {keys, retained};
              };
              const serverError = await run('probe-5xx', 503, '{"error":"busy"}');
              const malformed = await run('probe-malformed', 200, 'not-json');
              const clientError = await run('probe-4xx', 400, '{"error":"bad"}');
              window.fetch = original;
              return {serverError, malformed, clientError};
            }
        """)
        assert len(set(idempotency_probe["serverError"]["keys"])) == 1
        assert len(idempotency_probe["serverError"]["keys"]) == 2
        assert idempotency_probe["serverError"]["retained"] is True
        assert len(set(idempotency_probe["malformed"]["keys"])) == 1
        assert len(idempotency_probe["malformed"]["keys"]) == 2
        assert idempotency_probe["malformed"]["retained"] is True
        assert len(idempotency_probe["clientError"]["keys"]) == 1
        assert idempotency_probe["clientError"]["retained"] is False

        # An unresolved key that has fallen out of the server ledger is sent
        # replay-only, so it cannot execute accidentally. Cancelling preserves
        # the tombstone; explicit confirmation atomically replaces it with a
        # fresh key before exactly one new write.
        phase["name"] = "replay-only-confirmation"
        replay_http_start = len(http_errors)
        replay_console_start = len(console_errors)
        replay_probe_requests = []

        def replay_probe(route) -> None:
            headers = route.request.headers
            replay_probe_requests.append({
                "key": headers.get("idempotency-key"),
                "replayOnly": headers.get("idempotency-replay-only"),
            })
            if headers.get("idempotency-replay-only") == "1":
                route.fulfill(
                    status=409,
                    content_type="application/json",
                    body='{"error":"unknown replay","code":"IDEMPOTENCY_REPLAY_UNKNOWN"}',
                )
            else:
                route.fulfill(status=200, content_type="application/json", body='{"ok":true}')

        page.route("**/api/config", replay_probe)
        page.evaluate("""
            () => {
              const operation = 'probe-expired';
              const body = {scheduleStart: '05:43'};
              const fingerprint = operationFingerprint('/api/config', body);
              rememberUncertainOperation(operation, 'old-unresolved-key', fingerprint, Date.now() - 48 * 60 * 60 * 1000);
              window.__ztqReplayProbe = null;
              mutate(operation, null, '/api/config', body)
                .then(() => { window.__ztqReplayProbe = {ok: true}; })
                .catch(error => { window.__ztqReplayProbe = {ok: false, code: error.code}; });
            }
        """)
        expect(page.locator("#confirm-dialog")).to_be_visible()
        assert replay_probe_requests == [{"key": "old-unresolved-key", "replayOnly": "1"}]
        page.locator("#confirm-dialog .dialog-close").filter(has_text="取消").click()
        page.wait_for_function("() => window.__ztqReplayProbe !== null")
        assert page.evaluate("window.__ztqReplayProbe.code") == "UNCERTAIN_REPLAY_CANCELLED"
        retained_after_cancel = page.evaluate(
            "JSON.parse(localStorage.getItem('zcode-task-queue.uncertain-operations.v2'))",
        )
        retained_probe = next(entry for entry in retained_after_cancel if entry["operation"] == "probe-expired")
        assert retained_probe["key"] == "old-unresolved-key"

        page.evaluate("""
            () => {
              window.__ztqReplayProbe = null;
              mutate('probe-expired', null, '/api/config', {scheduleStart: '05:43'})
                .then(() => { window.__ztqReplayProbe = {ok: true}; })
                .catch(error => { window.__ztqReplayProbe = {ok: false, code: error.code}; });
            }
        """)
        expect(page.locator("#confirm-dialog")).to_be_visible()
        page.locator("#confirm-action").click()
        page.wait_for_function("() => window.__ztqReplayProbe !== null")
        assert page.evaluate("window.__ztqReplayProbe.ok") is True
        assert len(replay_probe_requests) == 3, replay_probe_requests
        assert replay_probe_requests[1] == {"key": "old-unresolved-key", "replayOnly": "1"}
        assert replay_probe_requests[2]["replayOnly"] is None
        assert replay_probe_requests[2]["key"] != "old-unresolved-key"
        replay_tombstones = page.evaluate(
            "localStorage.getItem('zcode-task-queue.uncertain-operations.v2')",
        )
        assert replay_tombstones is None, replay_tombstones
        page.unroute("**/api/config", replay_probe)
        replay_http_errors = http_errors[replay_http_start:]
        assert len(replay_http_errors) == 2, replay_http_errors
        assert all(
            error["phase"] == "replay-only-confirmation"
            and error["status"] == 409
            and error["resourceType"] == "fetch"
            and urlsplit(error["url"]).path == "/api/config"
            for error in replay_http_errors
        ), replay_http_errors
        del http_errors[replay_http_start:]
        replay_console_errors = console_errors[replay_console_start:]
        assert len(replay_console_errors) == 2, replay_console_errors
        assert all(
            "Failed to load resource" in message and "409" in message and "Conflict" in message
            for message in replay_console_errors
        ), replay_console_errors
        del console_errors[replay_console_start:]

        # If the durable tombstone cannot be written, no POST is attempted.
        phase["name"] = "uncertain-storage-failure"
        storage_probe = page.evaluate("""
            async () => {
              const original = Storage.prototype.setItem;
              let fetches = 0;
              const originalFetch = window.fetch;
              window.fetch = async (...args) => { fetches += 1; return originalFetch(...args); };
              Storage.prototype.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
              let message = '';
              try { await mutate('probe-storage', null, '/api/config', {scheduleStart: '05:44'}); }
              catch (error) { message = error.message; }
              Storage.prototype.setItem = original;
              window.fetch = originalFetch;
              uncertainStorageError = null;
              syncMutationControls();
              renderNotice();
              return {fetches, message};
            }
        """)
        assert storage_probe["fetches"] == 0, storage_probe
        assert "未发送" in storage_probe["message"], storage_probe
        assert page.locator("img[src=x]").count() == 0
        assert page.evaluate("window.__xss === undefined")
        expect(page.get_by_test_id("pending-list").get_by_test_id("task-row")).to_have_count(2)

        # Keyboard tab semantics.
        phase["name"] = "tabs-and-guard"
        page.get_by_test_id("tab-queue").focus()
        page.keyboard.press("ArrowRight")
        expect(page.get_by_test_id("tab-sessions")).to_have_attribute("aria-selected", "true")
        expect(page.get_by_test_id("panel-sessions")).to_be_visible()
        page.keyboard.press("End")
        expect(page.get_by_test_id("tab-guard")).to_have_attribute("aria-selected", "true")

        def rect(selector):
            value = page.locator(selector).bounding_box()
            assert value, selector
            return value

        def right(value):
            return value["x"] + value["width"]

        alignment_by_width = {}
        for viewport_width in (1440, 800, 761):
            page.set_viewport_size({"width": viewport_width, "height": 1000})
            schedule_end_box = rect("#schedule-end")
            stop_time_box = rect("#auto-stop-time")
            stop_button_box = rect("#stop-client-now")
            enable_time_box = rect("#auto-enable-time")
            enable_button_box = rect("#enable-client-now")
            assert abs(right(stop_button_box) - right(schedule_end_box)) <= 1
            assert abs(right(enable_button_box) - right(schedule_end_box)) <= 1
            assert abs(stop_time_box["x"] - enable_time_box["x"]) <= 1
            assert right(stop_time_box) <= stop_button_box["x"]
            assert right(enable_time_box) <= enable_button_box["x"]
            alignment_by_width[str(viewport_width)] = {
                "scheduleEndRight": right(schedule_end_box),
                "stopButtonRight": right(stop_button_box),
                "enableButtonRight": right(enable_button_box),
            }
        page.set_viewport_size({"width": 1440, "height": 1000})
        report["guardAlignment"] = alignment_by_width

        # A persisted guard failure is visible and states that it will retry.
        page.evaluate("""
            () => {
              const next = structuredClone(state);
              next.guardState.lastError = {message: '自动停止 ZCode 失败：仍有进程存活'};
              applyState(next, {force: true});
            }
        """)
        expect(page.get_by_test_id("guard-conflict")).to_contain_text("仍有进程存活")
        expect(page.get_by_test_id("guard-save-status")).to_have_text("守护将自动重试")
        page.evaluate("""
            () => {
              const next = structuredClone(state);
              next.guardState.lastError = null;
              applyState(next, {force: true});
            }
        """)

        # A clean focused guard field defers a remote refresh until focus leaves.
        schedule = page.get_by_test_id("schedule-start")
        initial_schedule = schedule.input_value()
        schedule.focus()
        clean_remote = page.request.post(
            f"{origin}/api/config",
            headers={
                **auth_headers,
                "Content-Type": "application/json",
                "X-ZTQ-Local": "1",
                "Idempotency-Key": f"ui-clean-focused-{run_key}",
            },
            data={"scheduleStart": "03:21"},
        )
        assert clean_remote.ok
        page.wait_for_function("() => state && state.settings.scheduleStart === '03:21'")
        expect(schedule).to_have_value(initial_schedule)
        page.get_by_test_id("tab-queue").focus()
        expect(schedule).to_have_value("03:21")

        # Dirty guard form must not be overwritten by an SSE update.
        schedule.fill("01:23")
        expect(page.get_by_test_id("guard-form")).to_have_attribute("data-edit-state", "dirty")
        remote = page.request.post(
            f"{origin}/api/config",
            headers={
                **auth_headers,
                "Content-Type": "application/json",
                "X-ZTQ-Local": "1",
                "Idempotency-Key": f"ui-dirty-{run_key}",
            },
            data={"scheduleStart": "02:34"},
        )
        assert remote.ok
        expect(page.get_by_test_id("guard-conflict")).to_be_visible(timeout=5000)
        expect(schedule).to_have_value("01:23")
        page.locator("#guard-save").click()
        expect(page.get_by_test_id("guard-form")).to_have_attribute("data-edit-state", "clean")

        # Resume and wait for strict serial completion to populate on-demand history.
        phase["name"] = "task-execution"
        page.get_by_test_id("tab-queue").click()
        set_queue_paused(False)
        expect(page.get_by_test_id("current-task")).to_be_visible(timeout=3000)
        stop_button = page.locator("#current-actions button[aria-label^='停止任务']")
        stop_button.focus()
        expect(stop_button).to_be_focused()
        page.evaluate("window.__ztqStableStop = document.querySelector(\"#current-actions button[aria-label^='停止任务']\")")
        page.evaluate("""
            () => {
              const next = structuredClone(state);
              const active = next.tasks.find(item => ['running', 'waiting'].includes(item.status));
              active.activity = '聚焦稳定性测试更新';
              next.revision += 1;
              applyState(next, {force: true});
            }
        """)
        assert page.evaluate("window.__ztqStableStop === document.querySelector(\"#current-actions button[aria-label^='停止任务']\")")
        expect(stop_button).to_be_focused()
        elapsed_before = page.locator("#current-elapsed").text_content()
        page.wait_for_function(
            "before => { const el = document.querySelector('#current-elapsed'); return el && el.textContent !== before; }",
            arg=elapsed_before,
            timeout=3500,
        )
        elapsed_after = page.locator("#current-elapsed").text_content()
        assert elapsed_before != elapsed_after
        expect(page.get_by_test_id("history-list").get_by_test_id("task-row")).to_have_count(2, timeout=12000)
        expect(page.get_by_test_id("pending-list").get_by_test_id("task-row")).to_have_count(0)
        expect(page.get_by_test_id("current-task")).to_be_hidden()
        expect(page.locator("#history-more")).to_be_hidden()

        first_history = page.get_by_test_id("history-list").get_by_test_id("task-row").filter(has_text=malicious_name)
        phase["name"] = "task-detail"
        expect(first_history).to_have_count(1)
        first_history.get_by_test_id("task-action-detail").click()
        expect(page.get_by_test_id("task-detail-dialog")).to_be_visible()
        expect(page.get_by_test_id("task-detail-content")).to_have_text(first_command)
        page.keyboard.press("Escape")
        expect(first_history.get_by_test_id("task-action-detail")).to_be_focused()

        first_history.get_by_test_id("task-action-log").click()
        phase["name"] = "task-log"
        expect(page.get_by_test_id("log-dialog")).to_be_visible()
        expect(page.get_by_test_id("log-content")).to_contain_text("ui-one", timeout=5000)
        page.get_by_test_id("log-close").click()

        # Soft-delete as one exact batch, then undo the returned IDs.
        phase["name"] = "history-trash-restore"
        page.locator("#history-clear").click()
        expect(page.locator("#confirm-dialog")).to_be_visible()
        page.locator("#confirm-action").click()
        expect(page.get_by_test_id("history-list").get_by_test_id("task-row")).to_have_count(0, timeout=5000)
        expect(page.get_by_test_id("trash-list").get_by_test_id("task-row")).to_have_count(2)
        page.get_by_test_id("undo-action").click()
        expect(page.get_by_test_id("history-list").get_by_test_id("task-row")).to_have_count(2, timeout=5000)
        expect(page.locator("#trash-count")).to_be_hidden()

        # A failed undo retains its handler and remains actionable; only a
        # confirmed success dismisses the toast.
        page.evaluate("""
            () => {
              window.__ztqUndoCalls = 0;
              showUndo('撤销重试验证', async () => {
                window.__ztqUndoCalls += 1;
                if (window.__ztqUndoCalls === 1) throw new Error('模拟临时失败');
              });
            }
        """)
        page.get_by_test_id("undo-action").click()
        expect(page.get_by_test_id("undo-action")).to_be_visible()
        assert page.evaluate("window.__ztqUndoCalls") == 1
        page.get_by_test_id("undo-action").click()
        expect(page.locator("#undo-toast")).to_be_hidden()
        assert page.evaluate("window.__ztqUndoCalls") == 2

        # A settings form submits only locally changed fields. A remote update
        # to an untouched field survives, while a same-field race is blocked.
        phase["name"] = "settings-dialog"
        settings_opener = page.get_by_test_id("settings-open")
        settings_opener.click()
        expect(page.get_by_test_id("settings-dialog")).to_be_visible()
        expect(page.locator("#settings-title")).to_be_focused()
        base_rounds = int(page.locator("#setting-rounds").input_value())
        base_interval = int(page.locator("#setting-interval").input_value())
        remote_rounds = base_rounds + 1 if base_rounds < 200 else base_rounds - 1
        remote_settings = page.request.post(
            f"{origin}/api/config",
            headers={
                **auth_headers,
                "Content-Type": "application/json",
                "X-ZTQ-Local": "1",
                "Idempotency-Key": f"ui-settings-merge-{run_key}",
            },
            data={"maxRounds": remote_rounds},
        )
        assert remote_settings.ok
        page.wait_for_function("rounds => state.settings.maxRounds === rounds", arg=remote_rounds)
        expect(page.locator("#setting-rounds")).to_have_value(str(base_rounds))
        local_interval = base_interval + 1 if base_interval < 86400 else base_interval - 1
        page.locator("#setting-interval").fill(str(local_interval))
        page.get_by_test_id("settings-save").click()
        expect(page.get_by_test_id("settings-dialog")).to_be_hidden()
        merged_settings = page.request.get(f"{origin}/api/state?view=summary", headers=auth_headers).json()["settings"]
        assert merged_settings["maxRounds"] == remote_rounds
        assert merged_settings["intervalSec"] == local_interval

        settings_opener.click()
        local_rounds = remote_rounds + 1 if remote_rounds < 200 else remote_rounds - 1
        competing_rounds = remote_rounds + 2 if remote_rounds <= 198 else remote_rounds - 2
        page.locator("#setting-rounds").fill(str(local_rounds))
        competing_settings = page.request.post(
            f"{origin}/api/config",
            headers={
                **auth_headers,
                "Content-Type": "application/json",
                "X-ZTQ-Local": "1",
                "Idempotency-Key": f"ui-settings-conflict-{run_key}",
            },
            data={"maxRounds": competing_rounds},
        )
        assert competing_settings.ok
        page.wait_for_function("rounds => state.settings.maxRounds === rounds", arg=competing_rounds)
        page.get_by_test_id("settings-save").click()
        expect(page.get_by_test_id("settings-dialog")).to_be_visible()
        expect(page.get_by_test_id("settings-error")).to_be_visible()
        assert page.request.get(f"{origin}/api/state?view=summary", headers=auth_headers).json()["settings"]["maxRounds"] == competing_rounds
        page.keyboard.press("Escape")
        expect(settings_opener).to_be_focused()

        page.screenshot(path=str(desktop_shot), full_page=True)
        assert not page_errors, page_errors
        assert not http_errors, http_errors
        assert not console_errors, console_errors
        report["desktop"] = {
            "revision": int(page.get_by_test_id("app-root").get_attribute("data-revision")),
            "historyRows": page.get_by_test_id("history-list").get_by_test_id("task-row").count(),
            "consoleErrors": len(console_errors),
            "pageErrors": len(page_errors),
        }

        # A restarted service may coincidentally have the same collection counts.
        # The new instance ID must still invalidate and reload history/trash.
        replacement_title = "Replacement instance history"

        def replacement_collections(route) -> None:
            if "status=history" in route.request.url:
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({
                        "items": [{
                            "id": "replacement-history",
                            "name": replacement_title,
                            "type": "shell",
                            "status": "done",
                            "phase": None,
                            "createdAt": 1,
                            "startedAt": 1,
                            "finishedAt": 1,
                            "timeoutMin": 0,
                            "error": None,
                            "activity": "",
                            "attempt": 0,
                            "round": 0,
                            "clientMayStillBeRunning": False,
                            "deletedAt": None,
                            "targetSessionId": None,
                            "usage": {"turns": 0, "events": 0},
                            "logTail": [],
                        }],
                        "nextCursor": None,
                    }),
                )
            else:
                route.fulfill(status=200, content_type="application/json", body='{"items":[],"nextCursor":null}')

        page.route("**/api/tasks?*", replacement_collections)
        replacement_state = page.request.get(f"{origin}/api/state?view=summary", headers=auth_headers).json()
        replacement_state["instanceId"] = "replacement-instance"
        page.evaluate("next => applyState(next, { force: true })", replacement_state)
        expect(page.get_by_test_id("history-list").get_by_text(replacement_title, exact=True)).to_be_visible(timeout=5000)
        page.unroute("**/api/tasks?*", replacement_collections)
        page.reload(wait_until="domcontentloaded")
        expect(page.get_by_test_id("app-root")).to_have_attribute("data-connection", "online", timeout=8000)
        expect(page.get_by_test_id("history-list").get_by_test_id("task-row")).to_have_count(2, timeout=5000)
        report["instanceReset"] = {"reloadedCollections": True}

        # Malformed state frames and transport failures both abandon the broken
        # EventSource and recover through writable GET polling.
        page.route("**/api/events?*", lambda route: route.abort())
        page.evaluate("eventSource.dispatchEvent(new MessageEvent('state', {data: '{malformed'}))")
        expect(page.get_by_test_id("app-root")).to_have_attribute("data-connection", "polling", timeout=8000)
        expect(page.get_by_test_id("queue-toggle")).to_be_enabled()
        page.reload(wait_until="domcontentloaded")
        expect(page.get_by_test_id("app-root")).to_have_attribute("data-connection", "polling", timeout=8000)
        expect(page.get_by_test_id("connection-status")).to_have_text("轮询连接")
        expect(page.get_by_test_id("queue-toggle")).to_be_enabled()
        report["fallback"] = {"connection": page.get_by_test_id("app-root").get_attribute("data-connection")}
        context.close()

        # A page without a fragment/session token stays visibly locked and does
        # not silently expose queue state.
        locked_context = browser.new_context(viewport={"width": 800, "height": 600})
        locked = locked_context.new_page()
        locked_api_requests = []
        locked.on("request", lambda request: locked_api_requests.append(request.url) if "/api/" in request.url else None)
        locked.goto(f"{origin}/", wait_until="domcontentloaded")
        expect(locked.get_by_test_id("app-root")).to_have_attribute("data-connection", "locked")
        expect(locked.get_by_test_id("connection-status")).to_have_text("需要授权")
        expect(locked.locator("#global-notice")).to_be_visible()
        locked.wait_for_timeout(2300)
        assert not locked_api_requests, locked_api_requests
        locked_context.close()

        # Coarse-pointer 320 px context verifies the touch floor and hostile
        # long-text wrapping without creating document-level horizontal scroll.
        mobile_context = browser.new_context(
            viewport={"width": 320, "height": 844},
            is_mobile=True,
            has_touch=True,
        )
        mobile = mobile_context.new_page()
        mobile.goto(page_url, wait_until="domcontentloaded")
        expect(mobile.get_by_test_id("app-root")).to_have_attribute("data-connection", "online", timeout=8000)
        mobile.get_by_test_id("tab-guard").click()
        expect(mobile.get_by_test_id("panel-guard")).to_be_visible()
        form_box = mobile.locator("#guard-form").bounding_box()
        schedule_start_box = mobile.locator("#schedule-start").bounding_box()
        assert form_box and schedule_start_box
        mobile_action_rights = []
        for time_selector, button_selector in (
            ("#auto-stop-time", "#stop-client-now"),
            ("#auto-enable-time", "#enable-client-now"),
        ):
            time_box = mobile.locator(time_selector).bounding_box()
            button = mobile.locator(button_selector)
            button_box = button.bounding_box()
            action_row = button.locator("..")
            action_row_box = action_row.bounding_box()
            action_row_padding_right = action_row.evaluate(
                "node => parseFloat(getComputedStyle(node).paddingRight)"
            )
            assert time_box and button_box and action_row_box
            assert abs(time_box["x"] - schedule_start_box["x"]) <= 1
            assert time_box["x"] + time_box["width"] <= button_box["x"] + 1
            assert abs(
                button_box["x"] + button_box["width"]
                - action_row_box["x"] - action_row_box["width"]
                + action_row_padding_right
            ) <= 1
            mobile_action_rights.append(button_box["x"] + button_box["width"])
        assert abs(mobile_action_rights[0] - mobile_action_rights[1]) <= 1
        assert mobile.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
        queue_box = mobile.get_by_test_id("queue-toggle").bounding_box()
        tab_box = mobile.get_by_test_id("tab-queue").bounding_box()
        assert queue_box and queue_box["height"] >= 44
        assert tab_box and tab_box["height"] >= 44
        mobile.evaluate("""
            () => {
              const next = structuredClone(state);
              next.tasks = [{
                id: 'mobile-long', name: 'N'.repeat(120), type: 'shell', status: 'running',
                phase: 'running', activity: 'A'.repeat(120), createdAt: 1, startedAt: Date.now(),
                finishedAt: null, timeoutMin: 0, error: null, result: null, attempt: 0,
                round: 0, clientMayStillBeRunning: false, deletedAt: null,
              }];
              next.counts = {...next.counts, active: 1, pending: 999};
              next.settings.completionMarker = 'M'.repeat(100);
              next.revision += 1;
              applyState(next, {force: true});
              document.querySelector('#queue-count').textContent = '999';
              document.querySelector('#queue-count').hidden = false;
              document.querySelector('#session-count').textContent = '999';
              document.querySelector('#session-count').hidden = false;
              selectTab('sessions');
              document.querySelector('#detail-title').textContent = 'D'.repeat(120);
              document.querySelector('#detail-dialog').showModal();
            }
        """)
        assert mobile.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
        mobile.screenshot(path=str(mobile_shot), full_page=True)
        mobile.locator("#detail-dialog").press("Escape")
        assert mobile.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
        report["mobile"] = {
            "width": mobile.evaluate("window.innerWidth"),
            "scrollWidth": mobile.evaluate("document.documentElement.scrollWidth"),
            "queueButtonHeight": queue_box["height"],
            "tabHeight": tab_box["height"],
        }
        mobile_context.close()
        browser.close()

    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
