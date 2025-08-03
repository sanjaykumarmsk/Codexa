const Discussion = require('../models/discussion');
const Comment = require('../models/comment');
const User = require('../models/user');
const { getIO } = require('../config/socket');

// Create a new discussion
exports.createDiscussion = async (req, res) => {
  try {
    const { title, content, community, tags } = req.body;
    const userId = req.user.id || req.result.id;

    if (!title || !content || !community) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const discussion = new Discussion({
      title,
      content,
      author: userId,
      community,
      tags: tags || []
    });

    await discussion.save();
    
    // Populate author information
    await discussion.populate('author', 'name email profileImage');
    
    // Emit socket event for new discussion
    const io = getIO();
    io.emit('new-discussion', discussion);

    return res.status(201).json({
      success: true,
      message: 'Discussion created successfully',
      discussion
    });
  } catch (error) {
    console.error('Error creating discussion:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Get all discussions with pagination and filtering
exports.getDiscussions = async (req, res) => {
  try {
    const { community, tag, sortBy = 'newest', page = 1, limit = 10, search } = req.query;
    const skip = (page - 1) * limit;

    // Build query based on filters
    const query = {};
    if (community && community !== 'all') query.community = community;
    if (tag) query.tags = { $in: [tag] };
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { content: { $regex: search, $options: 'i' } }
      ];
    }

    // Build sort options
    let sortOption = { createdAt: -1 }; // Default: newest first
    if (sortBy === 'popular') sortOption = { views: -1 };
    if (sortBy === 'mostUpvoted') sortOption = { 'upvotes.length': -1 };

    const discussions = await Discussion.find(query)
      .sort(sortOption)
      .skip(skip)
      .limit(parseInt(limit))
      .populate('author', 'name email profileImage')
      .lean();

    // Add comment count to each discussion
    const discussionsWithCommentCount = await Promise.all(
      discussions.map(async (discussion) => {
        const commentCount = await Comment.countDocuments({ discussion: discussion._id });
        return { ...discussion, commentCount };
      })
    );

    const totalDiscussions = await Discussion.countDocuments(query);
    const totalPages = Math.ceil(totalDiscussions / limit);

    return res.status(200).json({
      success: true,
      discussions: discussionsWithCommentCount,
      pagination: {
        totalDiscussions,
        totalPages,
        currentPage: parseInt(page),
        limit: parseInt(limit)
      }
    });
  } catch (error) {
    console.error('Error fetching discussions:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Get a single discussion by ID with comments
exports.getDiscussionById = async (req, res) => {
  try {
    const { id } = req.params;

    const discussion = await Discussion.findById(id)
      .populate('author', 'name email profileImage')
      .lean();

    if (!discussion) {
      return res.status(404).json({ success: false, message: 'Discussion not found' });
    }

    // Increment view count
    await Discussion.findByIdAndUpdate(id, { $inc: { views: 1 } });

    return res.status(200).json({
      success: true,
      discussion
    });
  } catch (error) {
    console.error('Error fetching discussion:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Update a discussion
exports.updateDiscussion = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content, tags } = req.body;
    const userId = req.user.id;

    const discussion = await Discussion.findById(id);

    if (!discussion) {
      return res.status(404).json({ success: false, message: 'Discussion not found' });
    }

    // Check if user is the author
    if (discussion.author.toString() !== userId) {
      return res.status(403).json({ success: false, message: 'You are not authorized to update this discussion' });
    }

    discussion.title = title || discussion.title;
    discussion.content = content || discussion.content;
    discussion.tags = tags || discussion.tags;
    discussion.updatedAt = Date.now();

    await discussion.save();
    await discussion.populate('author', 'name email profileImage');
    
    // Emit socket event for updated discussion
    const io = getIO();
    io.to(`discussion:${id}`).emit('discussion-updated', discussion);

    return res.status(200).json({
      success: true,
      message: 'Discussion updated successfully',
      discussion
    });
  } catch (error) {
    console.error('Error updating discussion:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Delete a discussion
exports.deleteDiscussion = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const discussion = await Discussion.findById(id);

    if (!discussion) {
      return res.status(404).json({ success: false, message: 'Discussion not found' });
    }

    // Check if user is the author
    if (discussion.author.toString() !== userId) {
      return res.status(403).json({ success: false, message: 'You are not authorized to delete this discussion' });
    }

    // Delete all comments associated with the discussion
    await Comment.deleteMany({ discussion: id });

    // Delete the discussion
    await Discussion.findByIdAndDelete(id);
    
    // Emit socket event for deleted discussion
    const io = getIO();
    io.to(`discussion:${id}`).emit('discussion-deleted', { discussionId: id });
    io.emit('discussion-list-updated');

    return res.status(200).json({
      success: true,
      message: 'Discussion deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting discussion:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Add a comment to a discussion
exports.addComment = async (req, res) => {
  try {
    const { discussionId } = req.params;
    const { content, parentComment } = req.body;
    const userId = req.user.id;

    if (!content) {
      return res.status(400).json({ success: false, message: 'Comment content is required' });
    }

    // Check if discussion exists
    const discussion = await Discussion.findById(discussionId);
    if (!discussion) {
      return res.status(404).json({ success: false, message: 'Discussion not found' });
    }

    // Create new comment
    const comment = new Comment({
      content,
      author: userId,
      discussion: discussionId,
      parentComment: parentComment || null
    });

    await comment.save();
    await comment.populate('author', 'name email profileImage');
    
    // Emit socket event for new comment
    const io = getIO();
    io.to(`discussion:${discussionId}`).emit('new-comment', comment);

    return res.status(201).json({
      success: true,
      message: 'Comment added successfully',
      comment
    });
  } catch (error) {
    console.error('Error adding comment:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Get comments for a discussion
exports.getComments = async (req, res) => {
  try {
    const { discussionId } = req.params;

    // Check if discussion exists
    const discussion = await Discussion.findById(discussionId);
    if (!discussion) {
      return res.status(404).json({ success: false, message: 'Discussion not found' });
    }

    // Get all comments for the discussion
    const comments = await Comment.find({ discussion: discussionId })
      .populate('author', 'name email profileImage')
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      comments
    });
  } catch (error) {
    console.error('Error fetching comments:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Update a comment
exports.updateComment = async (req, res) => {
  try {
    const { commentId } = req.params;
    const { content } = req.body;
    const userId = req.user.id;

    if (!content) {
      return res.status(400).json({ success: false, message: 'Comment content is required' });
    }

    const comment = await Comment.findById(commentId);

    if (!comment) {
      return res.status(404).json({ success: false, message: 'Comment not found' });
    }

    // Check if user is the author
    if (comment.author.toString() !== userId) {
      return res.status(403).json({ success: false, message: 'You are not authorized to update this comment' });
    }

    comment.content = content;
    comment.updatedAt = Date.now();

    await comment.save();
    await comment.populate('author', 'name email profileImage');
    
    // Emit socket event for updated comment
    const io = getIO();
    io.to(`discussion:${comment.discussion}`).emit('comment-updated', comment);

    return res.status(200).json({
      success: true,
      message: 'Comment updated successfully',
      comment
    });
  } catch (error) {
    console.error('Error updating comment:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Delete a comment
exports.deleteComment = async (req, res) => {
  try {
    const { commentId } = req.params;
    const userId = req.user.id;

    const comment = await Comment.findById(commentId);

    if (!comment) {
      return res.status(404).json({ success: false, message: 'Comment not found' });
    }

    // Check if user is the author
    if (comment.author.toString() !== userId) {
      return res.status(403).json({ success: false, message: 'You are not authorized to delete this comment' });
    }

    const discussionId = comment.discussion;

    // Delete the comment
    await Comment.findByIdAndDelete(commentId);
    
    // Emit socket event for deleted comment
    const io = getIO();
    io.to(`discussion:${discussionId}`).emit('comment-deleted', { commentId });

    return res.status(200).json({
      success: true,
      message: 'Comment deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting comment:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Vote on a discussion
exports.voteDiscussion = async (req, res) => {
  try {
    const { id } = req.params;
    const { voteType } = req.body; // 'upvote' or 'downvote'
    const userId = req.user.id;

    if (!['upvote', 'downvote'].includes(voteType)) {
      return res.status(400).json({ success: false, message: 'Invalid vote type' });
    }

    const discussion = await Discussion.findById(id);

    if (!discussion) {
      return res.status(404).json({ success: false, message: 'Discussion not found' });
    }

    // Check if user has already voted
    const hasUpvoted = discussion.upvotes.includes(userId);
    const hasDownvoted = discussion.downvotes.includes(userId);

    // Handle upvote
    if (voteType === 'upvote') {
      if (hasUpvoted) {
        // Remove upvote if already upvoted
        discussion.upvotes.pull(userId);
      } else {
        // Add upvote and remove downvote if exists
        discussion.upvotes.push(userId);
        if (hasDownvoted) {
          discussion.downvotes.pull(userId);
        }
      }
    }

    // Handle downvote
    if (voteType === 'downvote') {
      if (hasDownvoted) {
        // Remove downvote if already downvoted
        discussion.downvotes.pull(userId);
      } else {
        // Add downvote and remove upvote if exists
        discussion.downvotes.push(userId);
        if (hasUpvoted) {
          discussion.upvotes.pull(userId);
        }
      }
    }

    await discussion.save();
    
    // Emit socket event for updated votes
    const io = getIO();
    io.to(`discussion:${id}`).emit('discussion-voted', {
      discussionId: id,
      upvotes: discussion.upvotes,
      downvotes: discussion.downvotes
    });

    return res.status(200).json({
      success: true,
      message: 'Vote recorded successfully',
      upvotes: discussion.upvotes,
      downvotes: discussion.downvotes
    });
  } catch (error) {
    console.error('Error voting on discussion:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Vote on a comment
exports.voteComment = async (req, res) => {
  try {
    const { commentId } = req.params;
    const { voteType } = req.body; // 'upvote' or 'downvote'
    const userId = req.user.id;

    if (!['upvote', 'downvote'].includes(voteType)) {
      return res.status(400).json({ success: false, message: 'Invalid vote type' });
    }

    const comment = await Comment.findById(commentId);

    if (!comment) {
      return res.status(404).json({ success: false, message: 'Comment not found' });
    }

    // Check if user has already voted
    const hasUpvoted = comment.upvotes.includes(userId);
    const hasDownvoted = comment.downvotes.includes(userId);

    // Handle upvote
    if (voteType === 'upvote') {
      if (hasUpvoted) {
        // Remove upvote if already upvoted
        comment.upvotes.pull(userId);
      } else {
        // Add upvote and remove downvote if exists
        comment.upvotes.push(userId);
        if (hasDownvoted) {
          comment.downvotes.pull(userId);
        }
      }
    }

    // Handle downvote
    if (voteType === 'downvote') {
      if (hasDownvoted) {
        // Remove downvote if already downvoted
        comment.downvotes.pull(userId);
      } else {
        // Add downvote and remove upvote if exists
        comment.downvotes.push(userId);
        if (hasUpvoted) {
          comment.upvotes.pull(userId);
        }
      }
    }

    await comment.save();
    
    // Emit socket event for updated votes
    const io = getIO();
    io.to(`discussion:${comment.discussion}`).emit('comment-voted', {
      commentId,
      upvotes: comment.upvotes,
      downvotes: comment.downvotes
    });

    return res.status(200).json({
      success: true,
      message: 'Vote recorded successfully',
      upvotes: comment.upvotes,
      downvotes: comment.downvotes
    });
  } catch (error) {
    console.error('Error voting on comment:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};