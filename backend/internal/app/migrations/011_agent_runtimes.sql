-- Existing Agents and internal planners keep their Pi execution identity.
ALTER TABLE agents ADD COLUMN runtime text NOT NULL DEFAULT 'pi'
 CHECK (runtime IN ('pi', 'openai-agents'));
