# AGV Digital Twin - Flask Backend

## Project Structure

```
backend/
├── app.py              # Flask application with REST API and Socket.IO
├── templates/
│   └── dashboard.html  # Frontend dashboard UI
└── static/             # Static assets (CSS, JS, images)
```

## Running the Server

```bash
cd backend
python3 app.py
```

Access dashboard at: http://localhost:5000

## Endpoints

- `GET /` - Dashboard UI
- `GET /vehicle_state` - Current vehicle state
- `GET /trajectory` - Historical trajectory
- `GET /risk/heatmap` - Risk heatmap data
- `WS /socket.io/` - Real-time vehicle pose updates
