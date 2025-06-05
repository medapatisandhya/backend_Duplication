const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const Student = require('./models/Student'); // Assuming you have this model
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Ensure the data directory exists
const dataDirPath = path.join(__dirname, 'data');
if (!fs.existsSync(dataDirPath)) {
  fs.mkdirSync(dataDirPath);
}

// Load role skill weights from data/role_skill_weights.json
const roleSkillWeightsPath = path.join(__dirname, 'data', 'role_skill_weights.json');
let roleSkillWeights = {};
try {
  roleSkillWeights = JSON.parse(fs.readFileSync(roleSkillWeightsPath, 'utf8'));
} catch (err) {
  console.error("Error loading role_skill_weights.json:", err.message);
  console.log("Using empty roleSkillWeights. Please ensure 'data/role_skill_weights.json' exists and is valid JSON.");
}


// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log("MongoDB connected"))
.catch(err => console.log("DB error: ", err));

/**
 * Calculates a skill score based on user skills and role-specific skill weights.
 * @param {string[]} userSkills - Array of skills possessed by the user.
 * @param {object} roleSkills - Object mapping skills to their weights for a specific role.
 * @returns {number} The calculated skill score as a percentage.
 */
function calculateSkillScore(userSkills, roleSkills) {
  let totalScore = 0;
  let maxPossibleScore = 0;

  for (const [skill, weight] of Object.entries(roleSkills)) {
    maxPossibleScore += weight;
    if (userSkills.includes(skill)) {
      totalScore += weight;
    }
  }

  return maxPossibleScore > 0 ? (totalScore / maxPossibleScore) * 100 : 0;
}

/**
 * Calculates a similarity score between two sets of user skills based on role-specific weights.
 * @param {string[]} user1Skills - Skills of the first user.
 * @param {string[]} user2Skills - Skills of the second user.
 * @param {object} roleSkills - Object mapping skills to their weights for a specific role.
 * @returns {number} The calculated similarity score as a percentage.
 */
function calculateSimilarity(user1Skills, user2Skills, roleSkills) {
  // Calculate individual skill scores (though not directly used for similarity, good for context)
  const user1Score = calculateSkillScore(user1Skills, roleSkills);
  const user2Score = calculateSkillScore(user2Skills, roleSkills);

  // Find common skills between the two users
  const commonSkills = user1Skills.filter(skill => user2Skills.includes(skill));

  let weightedCommonScore = 0;
  let totalRoleWeight = 0;

  // Calculate weighted common score and total role weight
  for (const [skill, weight] of Object.entries(roleSkills)) {
    totalRoleWeight += weight;
    if (commonSkills.includes(skill)) {
      weightedCommonScore += weight;
    }
  }

  // Skill-based similarity component
  const skillSimilarity = totalRoleWeight > 0 ? (weightedCommonScore / totalRoleWeight) * 100 : 0;

  // Score difference component (closer scores mean higher similarity in this component)
  const scoreDifference = Math.abs(user1Score - user2Score);
  const scoreSimilarityComponent = Math.max(0, 100 - scoreDifference); // 100 if scores are identical, 0 if difference is 100 or more

  // Combine skill similarity and score similarity (e.g., 60% from skill match, 40% from score closeness)
  return (skillSimilarity * 0.6) + (scoreSimilarityComponent * 0.4);
}

/**
 * Checks if a user with the given email, first name, and last name already exists in the database.
 * Case-insensitive check.
 * @param {string} email - The email to check.
 * @param {string} firstName - The first name to check.
 * @param {string} lastName - The last name to check.
 * @returns {Promise<boolean>} True if a duplicate user is found, false otherwise.
 */
async function checkDuplicateUser(email, firstName, lastName) {
  try {
    const existingUser = await Student.findOne({
      $and: [
        { email: { $regex: new RegExp(`^${email}$`, 'i') } }, // Case-insensitive email
        { first_name: { $regex: new RegExp(`^${firstName}$`, 'i') } }, // Case-insensitive first name
        { last_name: { $regex: new RegExp(`^${lastName}$`, 'i') } } // Case-insensitive last name
      ]
    });

    return existingUser !== null;
  } catch (error) {
    console.error('Error checking duplicate user:', error);
    return false;
  }
}

// API endpoint for scanning skills and checking qualifications
app.post('/api/scan-skills', async (req, res) => {
  try {
    const { skills, job_preferences, email, first_name, last_name } = req.body;
    const desiredRoles = job_preferences?.desired_roles || [];

    // First, check for duplicate users
    if (email && first_name && last_name) {
      const isDuplicate = await checkDuplicateUser(email, first_name, last_name);
      if (isDuplicate) {
        return res.status(400).json({
          message: 'User with this email, first name, and last name already exists in the database. Cannot proceed with scan.',
          canSubmit: false,
          isDuplicate: true
        });
      }
    }

    let roleAnalysis = []; // Stores analysis for each desired role
    let overallCanSubmit = false; // Flag to determine if the user qualifies for at least one role

    // Iterate through each desired role to perform analysis
    for (const role of desiredRoles) {
      // Find existing users who prefer this role
      const existingUsers = await Student.find({
        'job_preferences.desired_roles': role
      });

      const isNewRole = existingUsers.length === 0; // Check if this is a new role in the database
      let newUserScore = 0;
      let similarityScore = 0;
      let status = '';
      let matchedUser = null; // Best matched existing user for this role

      if (isNewRole) {
        // If it's a new role, allow submission directly (Pioneer Path)
        status = 'PIONEER ROLE (Direct Submission)';
        overallCanSubmit = true; // New roles always allow submission
      } else {
        // If the role exists, check if it has defined skill weights
        if (!roleSkillWeights[role]) {
          // Role exists but no specific skill weights, use basic similarity matching
          let highestBasicSimilarity = 0;
          for (const existingUser of existingUsers) {
            const userSkills = existingUser.skills || [];
            const commonSkills = skills.filter(skill => userSkills.includes(skill));
            const maxSkills = Math.max(skills.length, userSkills.length);
            const basicSimilarity = maxSkills > 0 ? (commonSkills.length / maxSkills) * 100 : 0;

            if (basicSimilarity > highestBasicSimilarity) {
              highestBasicSimilarity = basicSimilarity;
              matchedUser = existingUser;
            }
          }
          similarityScore = highestBasicSimilarity;
          if (similarityScore >= 60) {
            status = 'BASIC MATCH (≥60% Similarity)';
            overallCanSubmit = true;
          } else {
            status = 'FAILED (Need ≥60% Similarity for Basic Match)';
          }
        } else {
          // Role exists with skill weights, perform detailed skill and similarity calculation
          const roleSkills = roleSkillWeights[role].skills;
          newUserScore = calculateSkillScore(skills, roleSkills); // User's skill score for this role

          let highestWeightedSimilarity = 0;
          for (const existingUser of existingUsers) {
            const currentSimilarity = calculateSimilarity(
              skills,
              existingUser.skills || [],
              roleSkills
            );
            if (currentSimilarity > highestWeightedSimilarity) {
              highestWeightedSimilarity = currentSimilarity;
              matchedUser = existingUser;
            }
          }
          similarityScore = highestWeightedSimilarity;

          // Check qualification criteria for existing roles with skill weights
          if (newUserScore >= 80 || similarityScore >= 80) {
            status = 'QUALIFIED (Skill Score ≥80% OR Similarity ≥80%)';
            overallCanSubmit = true;
          } else {
            status = 'FAILED (Need Skill Score ≥80% OR Similarity ≥80%)';
          }
        }
      }

      // Add the analysis for the current role to the results array
      roleAnalysis.push({
        roleName: role,
        isNewRole: isNewRole,
        skillScore: newUserScore,
        similarityScore: similarityScore,
        status: status,
        // Only include matchedUser details if there was a match for this specific role
        matchedUser: matchedUser ? {
          name: `${matchedUser.first_name} ${matchedUser.last_name}`,
          email: matchedUser.email,
          skills: matchedUser.skills
        } : null
      });
    }

    let finalMessage = '';
    if (overallCanSubmit) {
      finalMessage = 'Congratulations! You qualify for at least one desired role. Data is ready for submission.';
    } else {
      finalMessage = 'You do not meet the qualifications for any desired role. Please review the criteria.';
    }

    // Send back the comprehensive analysis and overall submission status
    res.json({
      canSubmit: overallCanSubmit,
      message: finalMessage,
      roleAnalysis: roleAnalysis, // Array of analysis for each role
      // For simplicity, we'll just send the first matched user found across all roles for display
      // You might want to refine this to show the best match for the *best* qualifying role.
      matchedUser: roleAnalysis.find(r => r.matchedUser)?.matchedUser || null
    });

  } catch (err) {
    console.error('Error in skill scanning:', err);
    res.status(500).json({
      message: 'Error scanning skills',
      error: err.message,
      canSubmit: false
    });
  }
});

// API endpoint for submitting student data to MongoDB
app.post('/api/students', async (req, res) => {
  try {
    const { email, first_name, last_name } = req.body;
    // Perform duplicate check again before saving to ensure data integrity
    const isDuplicate = await checkDuplicateUser(email, first_name, last_name);
    if (isDuplicate) {
      return res.status(400).json({
        message: 'User with this email, first name, and last name already exists in the database. Cannot submit.',
        error: 'Duplicate user'
      });
    }
    const student = new Student(req.body);
    await student.save();
    res.status(200).json({ message: 'Student data saved successfully to MongoDB!' });
  } catch (err) {
    console.error('Error saving student:', err);
    res.status(500).json({ message: 'Error saving student data to MongoDB', error: err.message });
  }
});

// NEW ENDPOINT: Save JSON data to a file on the server
app.post('/api/save-json-file', (req, res) => {
  const jsonData = req.body; // Get the JSON data from the request body
  const filePath = path.join(dataDirPath, 'student_schema.json'); // Define the file path

  if (!jsonData) {
    return res.status(400).json({ message: 'No JSON data provided to save.' });
  }

  try {
    // Write the JSON data to the file, formatted with 2 spaces for readability
    fs.writeFileSync(filePath, JSON.stringify(jsonData, null, 2), 'utf8');
    res.status(200).json({ message: `Data successfully saved to ${filePath} on the server.` });
  } catch (err) {
    console.error('Error saving JSON file on server:', err);
    res.status(500).json({ message: `Failed to save JSON file on server: ${err.message}` });
  }
});

// API endpoint for fetching all students from MongoDB
app.get('/api/students', async (req, res) => {
  try {
    const students = await Student.find({});
    res.status(200).json(students);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching students', error: err });
  }
});

const PORT = 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));