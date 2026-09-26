import React from "react";
import { TouchableOpacity, Text, StyleSheet } from "react-native";

const CancelButton = ({ onCancel }) => {
  return (
    <TouchableOpacity style={styles.button} onPress={onCancel}>
      <Text style={styles.buttonText}>Cancel</Text>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  button: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: "#ef4444",
    borderRadius: 6,
    marginTop: 8,
  },
  buttonText: {
    color: "white",
    fontWeight: "600",
  },
});

export default CancelButton;
