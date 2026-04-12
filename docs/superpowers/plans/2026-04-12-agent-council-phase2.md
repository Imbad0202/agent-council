# Agent Council Phase 2: Memory & Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SQLite-backed memory lifecycle (5 layers), anti-pattern detection (4 patterns), and session lifecycle management to the agent-council MVP.

**Architecture:** SQLite (brain.db) stores metadata, usage tracking, and FTS5 search index. Markdown files remain as human-readable content. Memory loader upgraded to 3-layer progressive disclosure. Anti-pattern detection runs via cheap LLM calls every 2 turns. Session lifecycle detects end via keywords, timeout, or turn count.

**Tech Stack:** better-sqlite3 (SQLite), existing stack (TypeScript, grammY, anthropic-ai/sdk)

**Spec:** docs/superpowers/specs/2026-04-12-agent-council-phase2-design.md

---

## 13 Tasks, ~32 new tests

See full plan content in the spec file. Tasks cover:
1. Types + better-sqlite3
2. Config loader update
3. SQLite database module
4. Usage tracker
5. Adaptive forgetting (pruner)
6. Episodic-to-semantic consolidator
7. Session lifecycle manager
8. Anti-pattern detector
9. Memory loader update
10. Personality builder update
11. Gateway router integration
12. Role assigner update
13. Final verification
