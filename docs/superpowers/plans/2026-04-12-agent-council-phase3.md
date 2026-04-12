# Agent Council Phase 3: Multi-Model, Multi-Bot, Dynamic Participation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Support multiple LLM providers (OpenAI, Google, Custom), independent Telegram bots per agent, dynamic agent participation with mid-session recruitment, and per-thread session isolation.

**Architecture:** Each agent gets its own Telegram bot for independent identity. One "listener" bot polls for messages, all bots can send. Provider factory creates the right LLM provider per agent config. Participation module dynamically selects which agents join each turn based on topic matching. Router maintains per-thread sessions for supergroup forum support.

**Tech Stack:** openai, @google/genai (new deps), existing stack

**Spec:** docs/superpowers/specs/2026-04-12-agent-council-phase3-design.md

---

## 11 Tasks

1. Install deps + update types (AgentConfig: botTokenEnv, topics; CouncilConfig: participation; CouncilMessage: threadId)
2. Update config loader (parse new fields with defaults)
3. OpenAI Provider
4. Google Provider
5. Custom Provider (OpenAI-compatible HTTP)
6. Provider Factory
7. Participation Module (topic matching + mid-session recruitment)
8. Multi-bot Telegram (listener/sender separation)
9. Per-thread sessions in Gateway Router
10. Update configs + .env.example
11. Final verification + push

Each task includes full test code and implementation — dispatched via subagent prompts with complete instructions.
