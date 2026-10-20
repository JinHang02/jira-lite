.PHONY: run test test-py test-js

run:            ## Start the server on http://localhost:8765 (PORT=... to change)
	python3 -m jira_lite

test: test-py test-js  ## Run all tests

test-py:
	python3 -m unittest discover -s tests/python -t .

test-js:
	node --test tests/js/*.test.mjs
