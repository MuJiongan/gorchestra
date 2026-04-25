.PHONY: install backend frontend test clean

install:
	cd backend && python -m pip install -e ".[dev]"
	cd frontend && npm install

backend:
	cd backend && uvicorn app.main:app --reload --port 8000

frontend:
	cd frontend && npm run dev

test:
	cd backend && pytest -q

clean:
	rm -f backend/*.db
	rm -rf backend/__pycache__ backend/app/__pycache__ backend/app/*/__pycache__
	rm -rf frontend/node_modules frontend/dist
