const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const app = express();

// Configuration - USE ENVIRONMENT VARIABLES
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN || 'elotouchcare';
const ZENDESK_DOMAIN = process.env.ZENDESK_DOMAIN || `https://${ZENDESK_SUBDOMAIN}.zendesk.com`;
const API_TOKEN = process.env.ZENDESK_API_TOKEN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const TARGET_TAG = process.env.TARGET_TAG || 'ev_new_message';
const PROCESSED_TAG = 'ev_processed'; // Tag to mark tickets as processed
const MACRO_ID = process.env.MACRO_ID || '31986608070935';
const TARGET_GROUP_ID = process.env.TARGET_GROUP_ID || '31112854673047'; // TS - NA/LATAM group ID

// In-memory cache to prevent duplicate processing within short time windows
const recentlyProcessed = new Map();
const PROCESSING_COOLDOWN_MS = 60000; // 1 minute cooldown

// Clean up old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ticketId, timestamp] of recentlyProcessed.entries()) {
    if (now - timestamp > PROCESSING_COOLDOWN_MS) {
      recentlyProcessed.delete(ticketId);
    }
  }
}, 300000);

// Validate required environment variables on startup
if (!API_TOKEN || !ZENDESK_EMAIL) {
  console.error('❌ FATAL: Missing required environment variables!');
  console.error('   Required: ZENDESK_API_TOKEN, ZENDESK_EMAIL');
  console.error('   Current values:');
  console.error(`   - ZENDESK_API_TOKEN: ${API_TOKEN ? '[SET]' : '[MISSING]'}`);
  console.error(`   - ZENDESK_EMAIL: ${ZENDESK_EMAIL ? '[SET]' : '[MISSING]'}`);
  process.exit(1);
}

// Middleware
app.use(express.json());

// Helper function to create authenticated Zendesk API headers
function getZendeskHeaders() {
  const authString = Buffer.from(`${ZENDESK_EMAIL}/token:${API_TOKEN}`).toString('base64');
  
  return {
    'Content-Type': 'application/json',
    'Authorization': `Basic ${authString}`
  };
}

// Extract contact information from ticket content
function extractContactInfo(ticketContent) {
  const $ = cheerio.load(ticketContent);
  const contactInfo = {
    firstName: '',
    lastName: '',
    email: '',
    phone: ''
  };

  try {
    console.log('Raw ticket content preview:', ticketContent.substring(0, 500));

    // Method 1: Look for table rows with contact information
    $('table tr').each((index, element) => {
      const cells = $(element).find('td');
      if (cells.length >= 2) {
        const label = $(cells[0]).text().trim();
        const value = $(cells[1]).text().trim();

        console.log(`Found table row: "${label}" = "${value}"`);

        switch (label) {
          case 'First Name':
            contactInfo.firstName = value;
            break;
          case 'Last Name':
            contactInfo.lastName = value;
            break;
          case 'Company Email':
            contactInfo.email = value;
            break;
          case 'Phone':
            contactInfo.phone = value;
            break;
        }
      }
    });

    // Method 2: Look for any text patterns that match your format
    const firstNameMatch = ticketContent.match(/First\s+Name[:\s]+([^\s\n<]+)/i);
    const lastNameMatch = ticketContent.match(/Last\s+Name[:\s]+([^\s\n<]+)/i);
    const emailMatch = ticketContent.match(/(?:Company\s+Email|Email)[:\s]+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
    const phoneMatch = ticketContent.match(/Phone[:\s]+([\d\-\+\(\)\s]+)/i);

    if (firstNameMatch) contactInfo.firstName = firstNameMatch[1];
    if (lastNameMatch) contactInfo.lastName = lastNameMatch[1];
    if (emailMatch) contactInfo.email = emailMatch[1];
    if (phoneMatch) contactInfo.phone = phoneMatch[1].trim();

    // Method 3: Look for any email pattern in the content
    if (!contactInfo.email) {
      const emailPattern = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
      const emails = ticketContent.match(emailPattern);
      if (emails && emails.length > 0) {
        // Filter out system emails
        const userEmail = emails.find(email => 
          !email.includes('elotouch.com') && 
          !email.includes('zendesk.com') &&
          !email.includes('noreply')
        );
        if (userEmail) {
          contactInfo.email = userEmail;
        }
      }
    }

    // Method 4: Look for highlighted content (yellow background)
    $('[style*="background"], .highlight').each((index, element) => {
      const text = $(element).text().trim();
      console.log(`Found highlighted text: "${text}"`);
      
      if (text.includes('@') && !contactInfo.email) {
        contactInfo.email = text;
      }
    });

    console.log('Extracted contact info:', contactInfo);

  } catch (error) {
    console.error('Error extracting contact info:', error);
  }

  return contactInfo;
}

// Check if user exists in Zendesk
async function findUserByEmail(email) {
  try {
    const response = await axios.get(
      `${ZENDESK_DOMAIN}/api/v2/users/search.json?query=email:${encodeURIComponent(email)}`,
      { headers: getZendeskHeaders() }
    );
    
    return response.data.users.length > 0 ? response.data.users[0] : null;
  } catch (error) {
    console.error('Error searching for user:', error.response?.data || error.message);
    return null;
  }
}

// Format phone number to E.164 format: +1XXXXXXXXXX
function formatPhoneNumber(phone) {
  if (!phone) return null;
  
  // Remove all non-digit characters
  const digitsOnly = phone.replace(/\D/g, '');
  
  // Invalid area codes (special service numbers)
  const invalidAreaCodes = ['211', '311', '411', '511', '611', '711', '811', '911'];
  
  // Detect fake/test numbers (all same digit, sequential, or obvious patterns)
  function isFakeNumber(digits) {
    // All same digit (1111111111, 0000000000, etc.)
    if (/^(\d)\1+$/.test(digits)) return true;
    
    // Common test patterns
    const testPatterns = [
      '1234567890', '0987654321', '1111111111', '0000000000',
      '1231231234', '5555555555', '9999999999'
    ];
    if (testPatterns.includes(digits)) return true;
    
    // Check the subscriber part (last 7 digits) for all same digit
    const subscriberPart = digits.slice(-7);
    if (/^(\d)\1+$/.test(subscriberPart)) return true;
    
    return false;
  }
  
  // Only process US numbers that we're confident about
  // If it's already 11 digits starting with 1, format as US number
  if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) {
    const areaCode = digitsOnly.slice(1, 4);
    const withoutCountryCode = digitsOnly.slice(1);
    
    // Check if it's a valid area code
    if (invalidAreaCodes.includes(areaCode)) {
      console.log(`Phone number "${phone}" has invalid area code ${areaCode} (special service number), skipping phone field`);
      return null;
    }
    
    // Check for fake numbers
    if (isFakeNumber(withoutCountryCode)) {
      console.log(`Phone number "${phone}" appears to be a fake/test number, skipping phone field`);
      return null;
    }
    
    return `+${digitsOnly}`;
  }
  
  // If it's 10 digits and looks like a valid US number
  if (digitsOnly.length === 10) {
    const areaCode = digitsOnly.slice(0, 3);
    
    // Check for fake numbers
    if (isFakeNumber(digitsOnly)) {
      console.log(`Phone number "${phone}" appears to be a fake/test number, skipping phone field`);
      return null;
    }
    
    // Only format if it looks like a valid US area code
    if (areaCode >= '200' && areaCode <= '999' && 
        !areaCode.startsWith('0') && 
        !areaCode.startsWith('1') &&
        !invalidAreaCodes.includes(areaCode)) {
      return `+1${digitsOnly}`;
    } else {
      console.log(`Phone number "${phone}" has invalid area code ${areaCode}, skipping phone field`);
      return null;
    }
  }
  
  // For any other format, skip the phone field to avoid validation errors
  console.log(`Phone number "${phone}" doesn't match US format, skipping phone field to avoid validation errors`);
  return null;
}

// Create new user in Zendesk
async function createUser(contactInfo) {
  const userData = {
    user: {
      name: `${contactInfo.firstName} ${contactInfo.lastName}`.trim(),
      email: contactInfo.email,
      role: 'end-user',
      verified: true
    }
  };

  try {
    // Only add phone if it can be properly formatted
    if (contactInfo.phone) {
      const formattedPhone = formatPhoneNumber(contactInfo.phone);
      if (formattedPhone) {
        userData.user.phone = formattedPhone;
        console.log(`Formatted phone: "${contactInfo.phone}" → "${formattedPhone}"`);
      }
    }

    console.log('Attempting to create/update user with data:', JSON.stringify(userData, null, 2));

    const response = await axios.post(
      `${ZENDESK_DOMAIN}/api/v2/users/create_or_update.json`,
      userData,
      { headers: getZendeskHeaders() }
    );

    console.log('Created/updated user:', response.data.user.id);
    return response.data.user;
  } catch (error) {
    console.error('Error creating user - Status:', error.response?.status);
    console.error('Error creating user - Data:', JSON.stringify(error.response?.data, null, 2));
    console.error('Error creating user - Details:', JSON.stringify(error.response?.data?.details, null, 2));
    console.error('Error creating user - Description:', error.response?.data?.description);
    console.error('Error creating user - Error:', error.response?.data?.error);
    console.error('Error creating user - Message:', error.message);
    console.error('User data that caused error:', JSON.stringify(userData, null, 2));
    
    // If the error is due to phone validation, retry without phone
    if (error.response?.status === 422 && error.response?.data?.details?.phone) {
      console.log('Phone validation failed, retrying without phone number...');
      delete userData.user.phone;
      
      try {
        const retryResponse = await axios.post(
          `${ZENDESK_DOMAIN}/api/v2/users/create_or_update.json`,
          userData,
          { headers: getZendeskHeaders() }
        );
        console.log('Created/updated user (without phone):', retryResponse.data.user.id);
        return retryResponse.data.user;
      } catch (retryError) {
        console.error('Retry without phone also failed:', retryError.message);
        throw retryError;
      }
    }
    
    throw error;
  }
}

// Update ticket with requestor and group assignment (but keep it open for macro)
async function updateTicketRequestor(ticketId, userId) {
  try {
    const updateData = {
      ticket: {
        requester_id: userId,
        assignee_id: null, // Remove individual assignee
        group_id: parseInt(TARGET_GROUP_ID), // Assign to "Elo Technical Support" group
        additional_tags: [PROCESSED_TAG], // Mark as processed to prevent re-processing
        comment: {
          body: 'Contact information processed and user assigned automatically.',
          public: false
        }
      }
    };

    console.log('Attempting to update ticket requestor with data:', JSON.stringify(updateData, null, 2));

    const response = await axios.put(
      `${ZENDESK_DOMAIN}/api/v2/tickets/${ticketId}.json`,
      updateData,
      { headers: getZendeskHeaders() }
    );

    console.log(`Updated ticket ${ticketId} with requestor ${userId} and assigned to group`);
    return response.data.ticket;
  } catch (error) {
    console.error('Error updating ticket requestor - Status:', error.response?.status);
    console.error('Error updating ticket requestor - Data:', JSON.stringify(error.response?.data, null, 2));
    throw error;
  }
}

// Close ticket
async function closeTicket(ticketId) {
  try {
    const updateData = {
      ticket: {
        status: 'solved'
      }
    };

    const response = await axios.put(
      `${ZENDESK_DOMAIN}/api/v2/tickets/${ticketId}.json`,
      updateData,
      { headers: getZendeskHeaders() }
    );

    console.log(`Closed ticket ${ticketId}`);
    return response.data.ticket;
  } catch (error) {
    console.error('Error closing ticket:', error.response?.data || error.message);
    throw error;
  }
}

// Verify macro exists and is active
async function verifyMacro(macroId) {
  try {
    const response = await axios.get(
      `${ZENDESK_DOMAIN}/api/v2/macros/${macroId}.json`,
      { headers: getZendeskHeaders() }
    );
    
    const macro = response.data.macro;
    console.log(`Found macro: "${macro.title}" (ID: ${macro.id}, Active: ${macro.active})`);
    console.log('Macro actions:', JSON.stringify(macro.actions, null, 2));
    
    return macro;
  } catch (error) {
    console.error('Error verifying macro:', error.response?.data || error.message);
    return null;
  }
}

// Apply macro to ticket
async function applyMacro(ticketId, macroId) {
  try {
    // First, get the macro to see its actions
    const macroResponse = await axios.get(
      `${ZENDESK_DOMAIN}/api/v2/macros/${macroId}.json`,
      { headers: getZendeskHeaders() }
    );
    
    const macro = macroResponse.data.macro;
    console.log(`Applying macro "${macro.title}" to ticket ${ticketId}`);
    console.log('Macro actions:', JSON.stringify(macro.actions, null, 2));
    
    // Build ticket update based on macro actions
    const updateData = { ticket: {} };
    
    let hasComment = false;
    
    macro.actions.forEach(action => {
      console.log(`Processing macro action: ${action.field} = ${action.value}`);
      
      switch (action.field) {
        case 'comment_value':
        case 'comment_value_html':
          updateData.ticket.comment = {
            body: action.value,
            public: true,
            html_body: action.field === 'comment_value_html' ? action.value : undefined
          };
          hasComment = true;
          console.log(`Adding comment from macro: ${action.value.substring(0, 100)}...`);
          break;
        case 'status':
          updateData.ticket.status = action.value;
          console.log(`Setting status from macro to: ${action.value}`);
          break;
        case 'priority':
          updateData.ticket.priority = action.value;
          break;
        case 'type':
          updateData.ticket.type = action.value;
          break;
        case 'group_id':
          updateData.ticket.group_id = action.value;
          break;
        case 'assignee_id':
          updateData.ticket.assignee_id = action.value;
          break;
        default:
          console.log(`Unknown macro action field: ${action.field}`);
      }
    });
    
    if (Object.keys(updateData.ticket).length === 0) {
      console.log(`⚠️ No applicable actions found in macro ${macroId}`);
      return null;
    }
    
    console.log('Applying macro actions:', JSON.stringify(updateData, null, 2));
    
    const response = await axios.put(
      `${ZENDESK_DOMAIN}/api/v2/tickets/${ticketId}.json`,
      updateData,
      { headers: getZendeskHeaders() }
    );
    
    console.log(`✅ Successfully applied macro ${macroId} actions to ticket ${ticketId}`);
    if (hasComment) {
      console.log('✅ Macro comment/email content has been posted to the ticket');
    }
    
    return response.data;
    
  } catch (error) {
    console.error('❌ Failed to apply macro:', error.response?.data || error.message);
    throw error;
  }
}

// Get ticket details
async function getTicketDetails(ticketId) {
  try {
    const response = await axios.get(
      `${ZENDESK_DOMAIN}/api/v2/tickets/${ticketId}.json?include=comments`,
      { headers: getZendeskHeaders() }
    );
    
    return response.data.ticket;
  } catch (error) {
    console.error('Error getting ticket details:', error.response?.data || error.message);
    throw error;
  }
}

// Main processing function - FIXED ORDER
async function processTicket(ticketId) {
  try {
    console.log(`Processing ticket ${ticketId}`);

    // Check in-memory cache first (fast check for rapid duplicate webhooks)
    if (recentlyProcessed.has(ticketId)) {
      console.log(`Ticket ${ticketId} was recently processed, skipping (in-memory cache)`);
      return { success: false, reason: 'Recently processed (cooldown)' };
    }

    // Get ticket details
    const ticket = await getTicketDetails(ticketId);
    
    // Check if ticket has the target tag
    if (!ticket.tags.includes(TARGET_TAG)) {
      console.log(`Ticket ${ticketId} doesn't have ${TARGET_TAG} tag, skipping`);
      return { success: false, reason: 'Missing target tag' };
    }

    // Check if ticket was already processed (has the processed tag)
    if (ticket.tags.includes(PROCESSED_TAG)) {
      console.log(`Ticket ${ticketId} already has ${PROCESSED_TAG} tag, skipping`);
      return { success: false, reason: 'Already processed' };
    }

    // Mark as being processed in memory cache
    recentlyProcessed.set(ticketId, Date.now());

    // Extract contact information from ticket description and comments
    let ticketContent = ticket.description || '';
    
    // Also check comments for contact info
    if (ticket.comments && ticket.comments.length > 0) {
      ticketContent += ' ' + ticket.comments.map(comment => comment.html_body || comment.body).join(' ');
    }

    const contactInfo = extractContactInfo(ticketContent);

    // Validate required information
    if (!contactInfo.email) {
      console.log(`No email found in ticket ${ticketId}`);
      return { success: false, reason: 'No email found' };
    }

    if (!contactInfo.firstName && !contactInfo.lastName) {
      console.log(`No name found in ticket ${ticketId}`);
      return { success: false, reason: 'No name found' };
    }

    console.log('Extracted contact info:', contactInfo);

    // Create or update user (handles both new and existing users)
    const user = await createUser(contactInfo);
    console.log(`Created/updated user: ${user.id} (${user.email})`);

    // STEP 1: Update ticket with user as requestor FIRST
    console.log('Step 1: Setting ticket requestor to ensure macro email goes to correct recipient...');
    await updateTicketRequestor(ticketId, user.id);

    // STEP 2: Apply the macro (now that the requestor is set correctly)
    try {
      const macro = await verifyMacro(MACRO_ID);
      if (macro) {
        console.log('Step 2: Applying macro with correct requestor...');
        await applyMacro(ticketId, MACRO_ID);
        console.log('✅ Macro applied successfully - email should go to customer');
      } else {
        console.log(`Warning: Macro ${MACRO_ID} not found, skipping macro application`);
      }
    } catch (macroError) {
      console.log(`Warning: Could not apply macro ${MACRO_ID}:`, macroError.message);
      // Continue even if macro fails
    }

    // STEP 3: Close the ticket (optional - the macro might already do this)
    console.log('Step 3: Closing ticket...');
    await closeTicket(ticketId);

    return {
      success: true,
      userId: user.id,
      userEmail: user.email,
      contactInfo: contactInfo
    };

  } catch (error) {
    console.error(`Error processing ticket ${ticketId}:`, error);
    return { success: false, reason: error.message };
  }
}

// Webhook endpoint for Zendesk
app.post('/webhook/zendesk', async (req, res) => {
  try {
    console.log('Received webhook:', JSON.stringify(req.body, null, 2));

    const ticketId = req.body.ticket?.id;
    
    if (!ticketId) {
      return res.status(400).json({ error: 'No ticket ID provided' });
    }

    const result = await processTicket(ticketId);
    
    res.json({
      success: result.success,
      ticketId: ticketId,
      result: result
    });

  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Manual processing endpoint (for testing)
app.post('/process-ticket/:ticketId', async (req, res) => {
  try {
    const ticketId = req.params.ticketId;
    const result = await processTicket(ticketId);
    
    res.json({
      success: result.success,
      ticketId: ticketId,
      result: result
    });

  } catch (error) {
    console.error('Manual processing error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Test macro endpoint - shows macro details and actions
app.get('/test-macro/:macroId', async (req, res) => {
  try {
    const macroId = req.params.macroId;
    const response = await axios.get(
      `${ZENDESK_DOMAIN}/api/v2/macros/${macroId}.json`,
      { headers: getZendeskHeaders() }
    );
    
    const macro = response.data.macro;
    
    res.json({
      success: true,
      macro: {
        id: macro.id,
        title: macro.title,
        active: macro.active,
        actions: macro.actions,
        description: macro.description
      }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: error.response?.data || error.message 
    });
  }
});

// Test auth endpoint - verify credentials are working
app.get('/test-auth', async (req, res) => {
  try {
    const response = await axios.get(
      `${ZENDESK_DOMAIN}/api/v2/users/me.json`,
      { headers: getZendeskHeaders() }
    );
    
    res.json({
      success: true,
      authenticated_as: response.data.user.email,
      user_id: response.data.user.id,
      role: response.data.user.role
    });
  } catch (error) {
    res.status(error.response?.status || 500).json({ 
      success: false,
      status: error.response?.status,
      error: error.response?.data || error.message,
      hint: error.response?.status === 401 ? 
        'Check ZENDESK_API_TOKEN and ZENDESK_EMAIL environment variables' : 
        'Unknown error'
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    zendesk_domain: ZENDESK_DOMAIN,
    email_configured: !!ZENDESK_EMAIL,
    token_configured: !!API_TOKEN
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Zendesk Contact Creator running on port ${PORT}`);
  console.log(`Webhook endpoint: http://localhost:${PORT}/webhook/zendesk`);
  console.log(`Manual processing: http://localhost:${PORT}/process-ticket/{ticketId}`);
  console.log(`Test auth: http://localhost:${PORT}/test-auth`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

module.exports = app;
