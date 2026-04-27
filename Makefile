.PHONY: install backend frontend test clean

VENV := backend/.venv

install:
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install --upgrade pip
	cd backend && .venv/bin/pip install -e ".[dev]"
	cd frontend && npm install

backend:
	cd backend && .venv/bin/uvicorn app.main:app --reload --port 8000

frontend:
	cd frontend && npm run dev

test:
	cd backend && .venv/bin/pytest -q

clean:
	rm -f backend/*.db
	rm -rf backend/__pycache__ backend/app/__pycache__ backend/app/*/__pycache__
	rm -rf frontend/node_modules frontend/dist
