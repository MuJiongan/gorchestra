.PHONY: install backend frontend dev test clean app app-install app-build app-bundle install-app

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

dev:
	@trap 'kill 0' INT TERM EXIT; \
	$(MAKE) backend & \
	$(MAKE) frontend & \
	wait

test:
	cd backend && .venv/bin/pytest -q

# --- native window app -----------------------------------------------------
app-install:
	cd backend && .venv/bin/pip install -e ".[dev,app]"

app-build:
	cd frontend && npm run build

app: app-build
	$(VENV)/bin/python launcher.py

app-bundle: app-build
	bash scripts/build_app.sh

# One-shot: build frontend, build .app, copy to /Applications.
# Quits any running instance first so the copy doesn't trip over an
# in-use bundle.
install-app: app-bundle
	@echo "→ quitting any running gorchestra..."
	-@pkill -f launcher.py 2>/dev/null || true
	-@osascript -e 'tell application "gorchestra" to quit' >/dev/null 2>&1 || true
	@sleep 1
	@echo "→ installing to /Applications/gorchestra.app..."
	@rm -rf /Applications/gorchestra.app
	@cp -R gorchestra.app /Applications/
	@echo ""
	@echo "Installed. Launch via Spotlight (Cmd+Space → gorchestra) or Launchpad."
	@echo "On first launch, right-click → Open to bypass the Gatekeeper warning."

clean:
	rm -f backend/*.db
	rm -rf backend/__pycache__ backend/app/__pycache__ backend/app/*/__pycache__
	rm -rf frontend/node_modules frontend/dist gorchestra.app
