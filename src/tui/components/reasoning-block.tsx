import React, { memo } from "react";
import { Box, Text } from "ink";

type ReasoningBlockProps = {
  text: string;
  durationSeconds: number;
  isExpanded: boolean;
};

export const ReasoningBlock = memo(function ReasoningBlock({
  text,
  durationSeconds,
  isExpanded,
}: ReasoningBlockProps) {
  if (isExpanded) {
    return (
      <Box flexDirection="column" marginLeft={2} marginBottom={1}>
        <Box>
          <Text color="gray">┌ </Text>
          <Text color="gray" dimColor>
            Thought for {durationSeconds}s
          </Text>
        </Box>
        <Box marginLeft={2}>
          <Text color="gray" dimColor wrap="wrap">
            {text}
          </Text>
        </Box>
        <Box>
          <Text color="gray">└ </Text>
          <Text color="gray" dimColor>
            (ctrl+p to hide thinking)
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box marginLeft={2} marginBottom={1}>
      <Text color="gray">○ </Text>
      <Text color="gray" dimColor>
        Thought for {durationSeconds}s
      </Text>
      <Text color="gray" dimColor>
        {" "}
        (ctrl+p to show thinking)
      </Text>
    </Box>
  );
});
