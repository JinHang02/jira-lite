.PHONY: run test test-py test-js test-e2e test-browser dev-mock cert

run:            ## Start the server on http://localhost:8765 (PORT=... to change)
	python3 -m app

test: test-py test-js test-e2e  ## Run all tests

test-py:
	python3 -m unittest discover -s tests/python -t .

test-js:
	node --test tests/js/*.test.mjs

cert:           ## Create certs/ for HTTPS: make cert HOSTS="192.168.0.113 my-mac.local"
	scripts/make-cert.sh $(HOSTS)

test-e2e:       ## End-to-end smoke test: real app against the mock Jira (offline)
	python3 -m unittest discover -s tests/e2e -t .

test-browser:   ## Headless Playwright pass over every UI flow (browser_e2e.js) against the mock; E2E_ONLY=regex, E2E_SHOTS=dir
	node tests/e2e/run_browser.mjs

dev-mock:       ## Mock Jira on :9900 + jira-lite on :8900 against it (.env ignored)
	python3 tests/e2e/mock_jira.py --port 9900 --app-port 8900
