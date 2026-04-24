# resmon-cloud service container.
# Python 3.10+, non-root user, slim base image.

FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Non-root user
RUN groupadd --system --gid 1001 resmon \
    && useradd --system --uid 1001 --gid resmon --home /home/resmon --create-home resmon

WORKDIR /app

# System deps (build-essential only for any wheels that need compilation;
# kept minimal to keep the image small).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies. The top-level requirements.txt is the same
# file used by the local backend; the cloud service imports the shared
# modules verbatim (see §7.2 of resmon_routines_and_accounts.md).
COPY requirements.txt /app/requirements.txt
RUN pip install --upgrade pip \
    && pip install -r /app/requirements.txt \
    && pip install "uvicorn[standard]" "sqlalchemy>=2.0" "alembic>=1.13" "psycopg[binary]>=3.1" "boto3>=1.34"

# Copy application sources. ``resmon_scripts`` is copied in full because the
# cloud worker imports the same api_*, normalizer, report_generator,
# summarizer, citation_graph, and sweep_engine modules as the desktop build.
COPY resmon_scripts /app/resmon_scripts

ENV PYTHONPATH=/app/resmon_scripts

USER resmon

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/api/v2/health || exit 1

# Entrypoint runs the cloud FastAPI factory via uvicorn.
CMD ["uvicorn", "resmon_scripts.cloud.app:create_app", \
     "--factory", "--host", "0.0.0.0", "--port", "8080"]
