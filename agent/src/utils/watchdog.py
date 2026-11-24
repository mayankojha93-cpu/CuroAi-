"""Watchdog utilities for Airtel telecom voice agent."""
import logging
import asyncio

logger = logging.getLogger("agent-watchdog")

async def clean_hangup(*args, **kwargs):
    logger.debug("clean_hangup called")

async def silence_watchdog(*args, **kwargs):
    logger.debug("silence_watchdog called")
