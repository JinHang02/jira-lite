.PHONY: run test test-py test-js cert

run:            ## Start the server on http://localhost:8765 (PORT=... to change)
	python3 -m jira_lite

test: test-py test-js  ## Run all tests

test-py:
	python3 -m unittest discover -s tests/python -t .

test-js:
	node --test tests/js/*.test.mjs

cert:           ## Create certs/ for HTTPS: make cert HOSTS="192.168.0.113 my-mac.local"
	scripts/make-cert.sh $(HOSTS)
