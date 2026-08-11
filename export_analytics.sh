#!/bin/bash

# Load environment variables
source ../.env

# Define output file name with today's date
FILENAME="analytics_$(date +%Y-%m-%d).csv"

# Execute the native PostgreSQL copy command
PGPASSWORD=$DB_PASSWORD psql -h localhost -U $DB_USER -d $DB_NAME -c "\copy (SELECT * FROM trade_analytics ORDER BY trade_date DESC) TO '$FILENAME' WITH CSV HEADER;"

echo "✅ Analytics successfully exported to $FILENAME"
