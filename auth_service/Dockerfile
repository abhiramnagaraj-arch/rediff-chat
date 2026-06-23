FROM python:3.12-slim

WORKDIR /app

# Install system dependencies needed for psycopg2 and JWT crypto verification
RUN apt-get update && apt-get install -y libpq-dev gcc libssl-dev libffi-dev && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY ./app ./app

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
